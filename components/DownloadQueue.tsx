"use client";

import { useState, useRef } from "react";
import {
  Box,
  Button,
  Flex,
  HStack,
  Icon,
  Image,
  Progress,
  Switch,
  Text,
  VStack,
  Badge,
  Tooltip,
  useToast,
  FormLabel,
} from "@chakra-ui/react";
import { motion, AnimatePresence } from "framer-motion";
import {
  FiDownload,
  FiTrash2,
  FiX,
  FiCheck,
  FiAlertCircle,
  FiImage,
  FiVideo,
  FiMusic,
  FiFile,
  FiPackage,
  FiRefreshCw,
  FiLoader,
} from "react-icons/fi";
import { DownloadItem, MediaType } from "@/types";

const MotionBox = motion(Box);

interface DownloadQueueProps {
  items: DownloadItem[];
  onRemove: (url: string) => void;
  onClear: () => void;
  onUpdate: (url: string, updates: Partial<DownloadItem>) => void;
  onDownloadComplete?: (items: DownloadItem[]) => void;
}

const typeIcon: Record<MediaType, React.ElementType> = {
  image: FiImage,
  video: FiVideo,
  gif: FiVideo,
  audio: FiMusic,
  unknown: FiFile,
};

const typeColor: Record<MediaType, string> = {
  image: "#60a5fa",
  video: "#f472b6",
  gif: "#a78bfa",
  audio: "#34d399",
  unknown: "#9ca3af",
};

const statusColor: Record<DownloadItem["status"], string> = {
  pending: "#444",
  downloading: "#ffeb3b",
  done: "#4ade80",
  error: "#f87171",
};

function formatSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// Trigger a browser file download from a Blob
function triggerDownload(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.style.display = "none";
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(objectUrl);
  }, 300);
}

// Convert base64 string to Blob
function base64ToBlob(base64: string, contentType: string): Blob {
  const byteChars = atob(base64);
  const byteArrays: Uint8Array[] = [];
  for (let offset = 0; offset < byteChars.length; offset += 512) {
    const slice = byteChars.slice(offset, offset + 512);
    const byteNumbers = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      byteNumbers[i] = slice.charCodeAt(i);
    }
    byteArrays.push(new Uint8Array(byteNumbers));
  }
  return new Blob(byteArrays, { type: contentType });
}

// Extract filename from Content-Disposition header or fall back to a default
function filenameFromResponse(res: Response, fallback: string): string {
  const cd = res.headers.get("content-disposition") || "";
  const match = cd.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
  if (match) {
    const raw = match[1].replace(/['"]/g, "").trim();
    if (raw) return decodeURIComponent(raw);
  }
  return fallback;
}

// ── SSE event types from the server ────────────────────────────────────────
interface SSEEvent {
  type:
    | "start"
    | "file_start"
    | "file_done"
    | "file_error"
    | "zipping"
    | "complete"
    | "error";
  total?: number;
  current?: number;
  index?: number;
  filename?: string;
  progress?: number;
  error?: string;
  message?: string;
  contentType?: string;
  data?: string; // base64 file data
  isZip?: boolean;
}

export default function DownloadQueue({
  items,
  onRemove,
  onClear,
  onUpdate,
  onDownloadComplete,
}: DownloadQueueProps) {
  const [downloading, setDownloading] = useState(false);
  const [saveAsZip, setSaveAsZip] = useState(false);
  const [overallProgress, setOverallProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState("");
  const [currentFileIndex, setCurrentFileIndex] = useState<number | null>(null);
  const [isZipping, setIsZipping] = useState(false);
  const abortRef = useRef<(() => void) | null>(null);
  const toast = useToast();

  const pendingItems = items.filter((i) => i.status === "pending");
  const doneItems = items.filter((i) => i.status === "done");
  const errorItems = items.filter((i) => i.status === "error");
  const activeItems = items.filter((i) => i.status === "downloading");

  // ── SSE-based download with per-file progress ──────────────────────────
  const handleDownloadAll = async () => {
    if (pendingItems.length === 0 || downloading) return;
    setDownloading(true);
    setOverallProgress(0);
    setStatusMessage("Starting download…");
    setCurrentFileIndex(null);
    setIsZipping(false);

    // Mark all as downloading
    pendingItems.forEach((item) =>
      onUpdate(item.url, { status: "downloading", progress: 0 })
    );

    const useZip = saveAsZip || pendingItems.length > 1;

    try {
      const itemsParam = encodeURIComponent(JSON.stringify(pendingItems));
      const url = `/api/download?items=${itemsParam}&forceZip=${useZip}`;

      const res = await fetch(url, { method: "GET" });

      if (!res.ok || !res.body) {
        throw new Error(`Server error: HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Allow cancellation
      abortRef.current = () => reader.cancel();

      const startTime = Date.now();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE lines
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // keep incomplete line

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;

          let event: SSEEvent;
          try {
            event = JSON.parse(raw);
          } catch {
            continue;
          }

          switch (event.type) {
            case "start":
              setStatusMessage(
                `Downloading ${event.total} file${event.total !== 1 ? "s" : ""}…`
              );
              break;

            case "file_start":
              setCurrentFileIndex(event.index ?? null);
              setStatusMessage(
                `Downloading ${event.current ?? (event.index ?? 0) + 1} of ${event.total}…`
              );
              // Mark this specific item as downloading
              if (event.index !== undefined && pendingItems[event.index]) {
                onUpdate(pendingItems[event.index].url, {
                  status: "downloading",
                  progress: 0,
                });
              }
              break;

            case "file_done":
              if (event.index !== undefined && pendingItems[event.index]) {
                onUpdate(pendingItems[event.index].url, {
                  status: useZip ? "downloading" : "done",
                  progress: useZip ? event.progress ?? 50 : 100,
                });
              }
              if (event.progress !== undefined) {
                setOverallProgress(event.progress);
              }
              setStatusMessage(
                `Downloaded ${event.current ?? (event.index ?? 0) + 1} of ${event.total} — ${event.filename}`
              );
              break;

            case "file_error":
              if (event.index !== undefined && pendingItems[event.index]) {
                onUpdate(pendingItems[event.index].url, {
                  status: "error",
                  error: event.error ?? "Download failed",
                  progress: undefined,
                });
              }
              if (event.progress !== undefined) {
                setOverallProgress(event.progress);
              }
              break;

            case "zipping":
              setIsZipping(true);
              setStatusMessage("Building ZIP archive…");
              setOverallProgress(99);
              // Mark all still-downloading items as near-done
              pendingItems.forEach((item) => {
                if (item.status === "downloading") {
                  onUpdate(item.url, { status: "downloading", progress: 99 });
                }
              });
              break;

            case "complete": {
              if (!event.data || !event.contentType || !event.filename) break;

              const blob = base64ToBlob(event.data, event.contentType);
              triggerDownload(blob, event.filename);

              // Mark all as done
              pendingItems.forEach((item) =>
                onUpdate(item.url, { status: "done", progress: 100 })
              );

              setOverallProgress(100);
              setIsZipping(false);

              if (onDownloadComplete) {
                onDownloadComplete(pendingItems);
              }

              const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
              toast({
                title: `${pendingItems.length} file${pendingItems.length !== 1 ? "s" : ""} downloaded in ${elapsed}s`,
                description: event.filename,
                status: "success",
                duration: 4000,
                isClosable: true,
                position: "top-right",
              });
              break;
            }

            case "error":
              throw new Error(event.message ?? "Download failed");
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      // Only mark still-downloading items as error
      pendingItems.forEach((item) => {
        if (item.status === "downloading") {
          onUpdate(item.url, { status: "error", error: msg });
        }
      });
      toast({
        title: "Download failed",
        description: msg,
        status: "error",
        duration: 6000,
        isClosable: true,
        position: "top-right",
      });
    } finally {
      setDownloading(false);
      setOverallProgress(0);
      setStatusMessage("");
      setCurrentFileIndex(null);
      setIsZipping(false);
      abortRef.current = null;
    }
  };

  // ── Download a single item (direct POST, no SSE needed) ────────────────
  const handleDownloadSingle = async (item: DownloadItem) => {
    onUpdate(item.url, { status: "downloading", progress: 0 });

    try {
      const res = await fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [item], forceZip: false }),
      });

      if (!res.ok) {
        const errBody = await res
          .json()
          .catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }

      const blob = await res.blob();
      const filename = filenameFromResponse(res, item.filename || "harveey_media");
      triggerDownload(blob, filename);

      onUpdate(item.url, { status: "done", progress: 100 });

      if (onDownloadComplete) {
        onDownloadComplete([item]);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Download failed";
      onUpdate(item.url, { status: "error", error: msg });
      toast({
        title: "Download failed",
        description: msg,
        status: "error",
        duration: 4000,
        isClosable: true,
        position: "top-right",
      });
    }
  };

  // ── Empty state ─────────────────────────────────────────────────────────
  if (items.length === 0) {
    return (
      <MotionBox
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        textAlign="center"
        py={20}
      >
        <Box
          w="64px"
          h="64px"
          bg="#111"
          border="1px solid #1a1a1a"
          borderRadius="16px"
          display="flex"
          alignItems="center"
          justifyContent="center"
          mx="auto"
          mb={4}
        >
          <Icon as={FiDownload} color="#333" boxSize={7} />
        </Box>
        <Text color="#444" fontSize="sm">
          Your download queue is empty
        </Text>
        <Text color="#333" fontSize="xs" mt={1}>
          Extract media from URLs or profiles to add items here
        </Text>
      </MotionBox>
    );
  }

  const totalFiles = pendingItems.length;
  const completedFiles = pendingItems.filter((i) => i.status === "done").length;

  return (
    <VStack spacing={4} align="stretch">
      {/* ── Queue header ── */}
      <MotionBox
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        bg="#0d0d0d"
        border="1px solid #1a1a1a"
        borderRadius="16px"
        p={5}
      >
        <Flex align="center" justify="space-between" flexWrap="wrap" gap={3}>
          {/* Counts */}
          <HStack spacing={3} flexWrap="wrap">
            <Text fontWeight="700" fontSize="lg">
              {items.length} item{items.length !== 1 ? "s" : ""}
            </Text>
            {pendingItems.length > 0 && (
              <Badge
                bg="rgba(85,85,85,0.13)"
                color="#888"
                borderRadius="full"
                px={2}
                fontSize="xs"
              >
                {pendingItems.length} pending
              </Badge>
            )}
            {activeItems.length > 0 && (
              <Badge
                bg="rgba(255,235,59,0.13)"
                color="#ffeb3b"
                borderRadius="full"
                px={2}
                fontSize="xs"
              >
                {activeItems.length} active
              </Badge>
            )}
            {doneItems.length > 0 && (
              <Badge
                bg="rgba(74,222,128,0.13)"
                color="#4ade80"
                borderRadius="full"
                px={2}
                fontSize="xs"
              >
                {doneItems.length} done
              </Badge>
            )}
            {errorItems.length > 0 && (
              <Badge
                bg="rgba(248,113,113,0.13)"
                color="#f87171"
                borderRadius="full"
                px={2}
                fontSize="xs"
              >
                {errorItems.length} failed
              </Badge>
            )}
          </HStack>

          {/* Actions */}
          <HStack spacing={3} flexWrap="wrap">
            {/* ZIP toggle — only show when there's 1 pending item */}
            {pendingItems.length === 1 && !downloading && (
              <HStack spacing={2}>
                <Switch
                  id="zip-toggle"
                  size="sm"
                  isChecked={saveAsZip}
                  onChange={(e) => setSaveAsZip(e.target.checked)}
                  colorScheme="yellow"
                  sx={{
                    "span.chakra-switch__track[data-checked]": {
                      bg: "#ffeb3b",
                    },
                  }}
                />
                <FormLabel
                  htmlFor="zip-toggle"
                  mb={0}
                  fontSize="xs"
                  color={saveAsZip ? "#ffeb3b" : "#555"}
                  cursor="pointer"
                  userSelect="none"
                  transition="color 0.2s"
                >
                  Save as ZIP
                </FormLabel>
              </HStack>
            )}

            {!downloading && (
              <Button
                size="sm"
                variant="ghostNeon"
                leftIcon={<Icon as={FiTrash2} />}
                onClick={onClear}
                color="#555"
                _hover={{ color: "#f87171" }}
              >
                Clear All
              </Button>
            )}

            {pendingItems.length > 0 && (
              <Button
                variant="neon"
                size="sm"
                leftIcon={
                  <Icon
                    as={
                      downloading
                        ? FiLoader
                        : pendingItems.length > 1 || saveAsZip
                        ? FiPackage
                        : FiDownload
                    }
                  />
                }
                onClick={handleDownloadAll}
                isLoading={downloading}
                loadingText={
                  isZipping
                    ? "Zipping…"
                    : currentFileIndex !== null
                    ? `File ${currentFileIndex + 1}/${totalFiles}`
                    : "Starting…"
                }
                isDisabled={downloading}
              >
                {pendingItems.length > 1
                  ? `Download All (${pendingItems.length}) as ZIP`
                  : saveAsZip
                  ? "Download as ZIP"
                  : "Download"}
              </Button>
            )}
          </HStack>
        </Flex>

        {/* ── Progress panel while downloading ── */}
        <AnimatePresence>
          {downloading && (
            <MotionBox
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              overflow="hidden"
              mt={4}
            >
              {/* Status message */}
              <Flex align="center" justify="space-between" mb={2}>
                <HStack spacing={2}>
                  <Box
                    w="6px"
                    h="6px"
                    borderRadius="full"
                    bg="#ffeb3b"
                    sx={{
                      animation: "pulse 1.2s ease-in-out infinite",
                      "@keyframes pulse": {
                        "0%, 100%": { opacity: 1 },
                        "50%": { opacity: 0.3 },
                      },
                    }}
                  />
                  <Text fontSize="xs" color="#888">
                    {statusMessage || "Working…"}
                  </Text>
                </HStack>
                {overallProgress > 0 && overallProgress < 100 && (
                  <Text fontSize="xs" color="#ffeb3b" fontWeight="700">
                    {overallProgress}%
                  </Text>
                )}
              </Flex>

              {/* Overall progress bar */}
              <Progress
                value={overallProgress}
                size="sm"
                colorScheme="yellow"
                bg="#1a1a1a"
                borderRadius="full"
                isIndeterminate={overallProgress === 0}
                sx={{
                  "& > div": {
                    transition: "width 0.4s ease",
                  },
                }}
              />

              {/* Per-file mini progress */}
              {totalFiles > 1 && (
                <Flex mt={2} gap={1} flexWrap="wrap">
                  {pendingItems.map((item, idx) => (
                    <Tooltip
                      key={item.url}
                      label={item.filename || `File ${idx + 1}`}
                      hasArrow
                      fontSize="xs"
                    >
                      <Box
                        w="8px"
                        h="8px"
                        borderRadius="2px"
                        bg={
                          item.status === "done"
                            ? "#4ade80"
                            : item.status === "error"
                            ? "#f87171"
                            : item.status === "downloading"
                            ? "#ffeb3b"
                            : "#2a2a2a"
                        }
                        transition="background 0.3s"
                        flexShrink={0}
                        sx={
                          item.status === "downloading"
                            ? {
                                animation: "pulse 0.8s ease-in-out infinite",
                              }
                            : {}
                        }
                      />
                    </Tooltip>
                  ))}
                </Flex>
              )}

              {isZipping && (
                <Text fontSize="xs" color="#a78bfa" mt={2}>
                  ✦ Compressing files into ZIP…
                </Text>
              )}
            </MotionBox>
          )}
        </AnimatePresence>
      </MotionBox>

      {/* ── Items list ── */}
      <VStack spacing={2} align="stretch">
        <AnimatePresence initial={false}>
          {items.map((item, idx) => {
            const TypeIcon = typeIcon[item.type] ?? FiFile;
            const color = typeColor[item.type] ?? "#9ca3af";

            return (
              <MotionBox
                key={item.url}
                layout
                initial={{ opacity: 0, x: -16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 16 }}
                transition={{ delay: Math.min(idx * 0.02, 0.3) }}
                bg="#0d0d0d"
                border="1px solid"
                borderColor={
                  item.status === "downloading"
                    ? "rgba(255,235,59,0.15)"
                    : item.status === "done"
                    ? "rgba(74,222,128,0.1)"
                    : item.status === "error"
                    ? "rgba(248,113,113,0.1)"
                    : "#1a1a1a"
                }
                borderRadius="12px"
                p={3}
                _hover={{ borderColor: "#2a2a2a" }}
                transition="border-color 0.2s"
              >
                <Flex align="center" gap={3}>
                  {/* Thumbnail */}
                  <Box
                    w="44px"
                    h="44px"
                    borderRadius="8px"
                    overflow="hidden"
                    flexShrink={0}
                    bg="#111"
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                  >
                    {item.thumbnail ? (
                      <Image
                        src={item.thumbnail}
                        alt={item.filename}
                        w="full"
                        h="full"
                        objectFit="cover"
                        fallback={
                          <Icon as={TypeIcon} color={color} boxSize={5} />
                        }
                      />
                    ) : (
                      <Icon as={TypeIcon} color={color} boxSize={5} />
                    )}
                  </Box>

                  {/* Info */}
                  <Box flex={1} minW={0}>
                    <Text
                      fontSize="sm"
                      fontWeight="500"
                      color="white"
                      noOfLines={1}
                      title={item.filename}
                    >
                      {item.filename}
                    </Text>
                    <HStack spacing={2} mt={0.5}>
                      <Text
                        fontSize="xs"
                        color={color}
                        fontWeight="600"
                        textTransform="uppercase"
                      >
                        {item.type}
                      </Text>
                      {item.size && (
                        <Text fontSize="xs" color="#555">
                          {formatSize(item.size)}
                        </Text>
                      )}
                      {item.platform && (
                        <Text fontSize="xs" color="#444">
                          {item.platform}
                        </Text>
                      )}
                    </HStack>

                    {item.status === "downloading" && (
                      <Box mt={1.5}>
                        <Progress
                          value={item.progress || 0}
                          size="xs"
                          colorScheme="yellow"
                          bg="#1a1a1a"
                          borderRadius="full"
                          isIndeterminate={
                            !item.progress || item.progress === 0
                          }
                          sx={{
                            "& > div": { transition: "width 0.3s ease" },
                          }}
                        />
                        {item.progress !== undefined && item.progress > 0 && (
                          <Text fontSize="10px" color="#666" mt={0.5}>
                            {item.progress}%
                          </Text>
                        )}
                      </Box>
                    )}

                    {item.status === "error" && item.error && (
                      <Text
                        fontSize="xs"
                        color="#f87171"
                        mt={0.5}
                        noOfLines={1}
                      >
                        {item.error}
                      </Text>
                    )}
                  </Box>

                  {/* Status dot + action buttons */}
                  <HStack spacing={2} flexShrink={0}>
                    <Box
                      w="7px"
                      h="7px"
                      borderRadius="full"
                      bg={statusColor[item.status]}
                      flexShrink={0}
                      sx={
                        item.status === "downloading"
                          ? {
                              animation: "pulse 1s ease-in-out infinite",
                              "@keyframes pulse": {
                                "0%, 100%": { opacity: 1 },
                                "50%": { opacity: 0.2 },
                              },
                            }
                          : {}
                      }
                    />

                    {/* Download single (only when not in batch download) */}
                    {item.status === "pending" && !downloading && (
                      <Tooltip label="Download this file" hasArrow>
                        <Box
                          as="button"
                          w="28px"
                          h="28px"
                          bg="#111"
                          border="1px solid #1a1a1a"
                          borderRadius="7px"
                          display="flex"
                          alignItems="center"
                          justifyContent="center"
                          onClick={() => handleDownloadSingle(item)}
                          _hover={{
                            bg: "#1a1a1a",
                            borderColor: "rgba(255,235,59,0.27)",
                          }}
                          transition="all 0.15s"
                        >
                          <Icon as={FiDownload} color="#666" boxSize={3.5} />
                        </Box>
                      </Tooltip>
                    )}

                    {item.status === "done" && (
                      <Icon as={FiCheck} color="#4ade80" boxSize={4} />
                    )}

                    {/* Retry on error */}
                    {item.status === "error" && (
                      <Tooltip label="Retry" hasArrow>
                        <Box
                          as="button"
                          w="28px"
                          h="28px"
                          bg="#1a0a0a"
                          border="1px solid rgba(248,113,113,0.2)"
                          borderRadius="7px"
                          display="flex"
                          alignItems="center"
                          justifyContent="center"
                          onClick={() =>
                            onUpdate(item.url, {
                              status: "pending",
                              error: undefined,
                              progress: undefined,
                            })
                          }
                          _hover={{ bg: "#2a0a0a" }}
                          transition="all 0.15s"
                        >
                          <Icon as={FiRefreshCw} color="#f87171" boxSize={3.5} />
                        </Box>
                      </Tooltip>
                    )}

                    {/* Remove (disabled during download) */}
                    {!downloading && (
                      <Tooltip label="Remove" hasArrow>
                        <Box
                          as="button"
                          w="28px"
                          h="28px"
                          bg="#111"
                          border="1px solid #1a1a1a"
                          borderRadius="7px"
                          display="flex"
                          alignItems="center"
                          justifyContent="center"
                          onClick={() => onRemove(item.url)}
                          _hover={{
                            bg: "#1a0a0a",
                            borderColor: "rgba(248,113,113,0.2)",
                          }}
                          transition="all 0.15s"
                        >
                          <Icon as={FiX} color="#555" boxSize={3.5} />
                        </Box>
                      </Tooltip>
                    )}
                  </HStack>
                </Flex>
              </MotionBox>
            );
          })}
        </AnimatePresence>
      </VStack>
    </VStack>
  );
}
