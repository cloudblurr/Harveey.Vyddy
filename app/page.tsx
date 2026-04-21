"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Box,
  Container,
  Flex,
  HStack,
  Text,
  VStack,
  useToast,
  Badge,
} from "@chakra-ui/react";
import { motion } from "framer-motion";
import Header from "@/components/Header";
import TabNav from "@/components/TabNav";
import UrlExtractor from "@/components/UrlExtractor";
import ProfileBrowser from "@/components/ProfileBrowser";
import DownloadQueue from "@/components/DownloadQueue";
import DownloadHistory from "@/components/DownloadHistory";
import AgentChat from "@/components/AgentChat";
import { DownloadItem } from "@/types";

const MotionBox = motion(Box);

export default function Home() {
  const [activeTab, setActiveTab] = useState<"extract" | "profile" | "queue" | "history" | "agent">("extract");
  const [downloadQueue, setDownloadQueue] = useState<DownloadItem[]>([]);
  const [extractorSeedUrl, setExtractorSeedUrl] = useState<string | undefined>(undefined);
  const [extensionQueueCount, setExtensionQueueCount] = useState(0);
  const toast = useToast();

  // Poll for extension queue items
  const pollExtensionQueue = useCallback(async () => {
    // Abort if the request takes longer than 8 seconds
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetch("/api/extension/send", {
        method: "GET",
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) return; // silently skip non-200 responses

      const data = await res.json();

      if (data.success && data.items && data.items.length > 0) {
        setDownloadQueue((prev) => {
          const existingUrls = new Set(prev.map((i) => i.url));
          const newItems = data.items.filter((i: DownloadItem) => !existingUrls.has(i.url));
          if (newItems.length > 0) {
            toast({
              title: `${newItems.length} item${newItems.length > 1 ? "s" : ""} from extension`,
              description: "Added to download queue",
              status: "info",
              duration: 3000,
              position: "top-right",
            });
            setActiveTab("queue");
          }
          return [...prev, ...newItems];
        });
        setExtensionQueueCount(data.items.length);
      } else {
        setExtensionQueueCount(0);
      }
    } catch (error) {
      clearTimeout(timeout);
      // Silently ignore aborts and network errors — polling will retry
      if (error instanceof Error && error.name !== "AbortError") {
        console.error("Failed to poll extension queue:", error);
      }
    }
  }, [toast]);

  // Poll every 10 seconds — fast enough to feel responsive, light enough for serverless
  useEffect(() => {
    pollExtensionQueue();
    const interval = setInterval(pollExtensionQueue, 10000);
    return () => clearInterval(interval);
  }, [pollExtensionQueue]);

  // Mark items as processed when they're downloaded
  const handleDownloadComplete = async (items: DownloadItem[]) => {
    try {
      await fetch("/api/extension/send", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemIds: items.map(i => i.id) }),
      });
    } catch (error) {
      console.error("Failed to mark items as processed:", error);
    }
  };

  const addToQueue = (items: DownloadItem[]) => {
    setDownloadQueue((prev) => {
      const existingUrls = new Set(prev.map((i) => i.url));
      const newItems = items.filter((i) => !existingUrls.has(i.url));
      return [...prev, ...newItems];
    });
  };

  const removeFromQueue = (url: string) => {
    setDownloadQueue((prev) => prev.filter((i) => i.url !== url));
  };

  const clearQueue = () => setDownloadQueue([]);

  const updateQueueItem = (url: string, updates: Partial<DownloadItem>) => {
    setDownloadQueue((prev) =>
      prev.map((i) => (i.url === url ? { ...i, ...updates } : i))
    );
  };

  // Called by ProfileBrowser — pre-fill the extractor and switch tabs
  const sendToExtractor = (url: string) => {
    setExtractorSeedUrl(url);
    setActiveTab("extract");
  };

  return (
    <Box minH="100vh" className="gradient-bg grid-overlay" position="relative">
      {/* Scan line effect */}
      <Box className="scan-line" />

      {/* Ambient glow */}
      <Box
        position="fixed"
        top="-200px"
        left="50%"
        transform="translateX(-50%)"
        w="800px"
        h="400px"
        bg="radial-gradient(ellipse, rgba(255,235,59,0.06) 0%, transparent 70%)"
        pointerEvents="none"
        zIndex={0}
      />

      <Container maxW="1400px" px={{ base: 4, md: 6 }} position="relative" zIndex={1}>
        <Header queueCount={downloadQueue.length} extensionQueueCount={extensionQueueCount} />

        <TabNav
          activeTab={activeTab}
          onTabChange={setActiveTab}
          queueCount={downloadQueue.length}
        />

        <MotionBox
          key={activeTab}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          pb={12}
        >
          {activeTab === "extract" && (
            <UrlExtractor
              onAddToQueue={addToQueue}
              seedUrl={extractorSeedUrl}
              onSeedConsumed={() => setExtractorSeedUrl(undefined)}
            />
          )}
          {activeTab === "profile" && (
            <ProfileBrowser onSendToExtractor={sendToExtractor} />
          )}
          {activeTab === "queue" && (
            <DownloadQueue
              items={downloadQueue}
              onRemove={removeFromQueue}
              onClear={clearQueue}
              onUpdate={updateQueueItem}
              onDownloadComplete={handleDownloadComplete}
            />
          )}
          {activeTab === "history" && (
            <DownloadHistory />
          )}
          {activeTab === "agent" && (
            <AgentChat onAddToQueue={addToQueue} />
          )}
        </MotionBox>
      </Container>
    </Box>
  );
}
