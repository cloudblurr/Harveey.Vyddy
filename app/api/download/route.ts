import { NextRequest, NextResponse } from "next/server";
import { DownloadItem } from "@/types";
import path from "path";
import fs from "fs";

// ── AdjectiveAdjectiveAnimal ZIP name generator ────────────────────────────
const ADJECTIVES = [
  "Amber","Arctic","Blazing","Bold","Brave","Bright","Calm","Clever","Cosmic",
  "Crimson","Crystal","Daring","Dark","Dawn","Deep","Divine","Dusty","Electric",
  "Emerald","Epic","Fierce","Fiery","Frosty","Fuzzy","Giant","Gilded","Glowing",
  "Golden","Grand","Gritty","Hidden","Hollow","Icy","Indigo","Iron","Jade",
  "Jolly","Keen","Lazy","Lofty","Lone","Lucky","Lunar","Majestic","Marble",
  "Mighty","Misty","Neon","Noble","Obsidian","Odd","Onyx","Pale","Phantom",
  "Primal","Proud","Quiet","Radiant","Rapid","Rogue","Royal","Ruby","Rustic",
  "Sacred","Savage","Scarlet","Shadow","Sharp","Silent","Silver","Sleek","Sly",
  "Solar","Sonic","Spectral","Stealthy","Steel","Stormy","Strange","Swift",
  "Teal","Thunder","Tiny","Toxic","Turbo","Twilight","Ultra","Velvet","Vibrant",
  "Violet","Vivid","Wild","Windy","Wired","Wise","Witty","Zany","Zealous","Zen",
];

const ANIMALS = [
  "Albatross","Axolotl","Badger","Basilisk","Bear","Bison","Bobcat","Buffalo",
  "Capybara","Caracal","Cheetah","Chimera","Cobra","Condor","Cougar","Coyote",
  "Crane","Crow","Dingo","Dolphin","Dragon","Eagle","Falcon","Ferret","Fox",
  "Gecko","Gorilla","Griffin","Grizzly","Hawk","Hedgehog","Hippo","Hyena",
  "Ibis","Iguana","Jaguar","Kestrel","Komodo","Kraken","Lemur","Leopard",
  "Lynx","Mamba","Manta","Marmot","Mongoose","Moose","Narwhal","Ocelot",
  "Osprey","Otter","Panther","Parrot","Pelican","Phoenix","Puma","Python",
  "Raven","Rhino","Salamander","Scorpion","Serval","Shark","Sloth","Sphinx",
  "Stallion","Stingray","Stoat","Tiger","Titan","Toucan","Viper","Vulture",
  "Walrus","Weasel","Wolf","Wolverine","Wombat","Wyvern","Yak","Zebra",
];

function generateZipName(): string {
  const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
  const adj1 = pick(ADJECTIVES);
  let adj2 = pick(ADJECTIVES);
  while (adj2 === adj1) adj2 = pick(ADJECTIVES);
  const animal = pick(ANIMALS);
  return `${adj1}${adj2}${animal}.zip`;
}

// Save completed downloads to history
async function saveToHistory(items: DownloadItem[]) {
  const historyPath = path.join(process.cwd(), ".harveey-history.json");

  let history: unknown[] = [];
  try {
    if (fs.existsSync(historyPath)) {
      const data = fs.readFileSync(historyPath, "utf-8");
      history = JSON.parse(data);
    }
  } catch {
    history = [];
  }

  const newItems = items.map((item) => ({
    id: item.id,
    url: item.url,
    filename: item.filename,
    type: item.type,
    platform: item.platform,
    thumbnail: item.thumbnail,
    status: "completed",
    timestamp: Date.now(),
    source: "app",
  }));

  history = [...newItems, ...history].slice(0, 500);

  try {
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
  } catch (error) {
    console.error("Failed to save history:", error);
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes for large batches

// Fetch a single media file with timeout
async function fetchMediaBuffer(
  url: string
): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "*/*",
        Referer: (() => {
          try {
            return new URL(url).origin;
          } catch {
            return "";
          }
        })(),
      },
      signal: controller.signal,
      redirect: "follow",
    });

    clearTimeout(timeout);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const contentType =
      res.headers.get("content-type") || "application/octet-stream";
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const cd = res.headers.get("content-disposition") || "";
    const cdMatch = cd.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
    let filename = cdMatch ? cdMatch[1].replace(/['"]/g, "").trim() : "";
    if (!filename) {
      try {
        filename =
          path.basename(new URL(url).pathname.split("?")[0]) || "media";
      } catch {
        filename = "media";
      }
    }

    return { buffer, contentType, filename };
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ── SSE progress endpoint: POST /api/download (with SSE response) ───────────
// Streams progress events then the final file as base64 in the last event.
// This lets the frontend show per-file progress while downloading sequentially.
// Uses POST to avoid URL length limits with many items.
async function handleSSEDownload(items: DownloadItem[], forceZip: boolean) {

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
        );
      };

      try {
        const useZip = forceZip || items.length > 1;

        if (!useZip) {
          // ── Single file ──────────────────────────────────────────────────
          const item = items[0];
          send({ type: "start", total: 1, current: 0 });
          send({
            type: "file_start",
            index: 0,
            filename: item.filename || "media",
            total: 1,
          });

          try {
            const { buffer, contentType, filename } = await fetchMediaBuffer(
              item.url
            );
            const safeName = item.filename || filename;

            send({
              type: "file_done",
              index: 0,
              filename: safeName,
              total: 1,
            });

            send({
              type: "complete",
              filename: safeName,
              contentType,
              data: buffer.toString("base64"),
              isZip: false,
            });

            saveToHistory([item]);
          } catch (err) {
            send({
              type: "file_error",
              index: 0,
              filename: item.filename || "media",
              error: err instanceof Error ? err.message : "Unknown error",
            });
            send({ type: "error", message: "Failed to download file." });
          }
        } else {
          // ── Multiple files → ZIP, one at a time with progress ────────────
          const archiver = (await import("archiver")).default;
          const arc = archiver("zip", { zlib: { level: 6 } });
          const chunks: Buffer[] = [];

          arc.on("data", (chunk: Buffer) => chunks.push(chunk));

          const zipReady = new Promise<void>((resolve, reject) => {
            arc.on("end", resolve);
            arc.on("error", reject);
          });

          send({ type: "start", total: items.length, current: 0 });

          // Download files ONE AT A TIME so user sees clear sequential progress
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            send({
              type: "file_start",
              index: i,
              filename: item.filename || `file_${i + 1}`,
              total: items.length,
              current: i + 1,
            });

            try {
              const { buffer, filename } = await fetchMediaBuffer(item.url);
              const safeName =
                item.filename ||
                filename ||
                `media_${i + 1}${path.extname(item.url.split("?")[0]) || ""}`;

              arc.append(buffer, { name: safeName });

              send({
                type: "file_done",
                index: i,
                filename: safeName,
                total: items.length,
                current: i + 1,
                progress: Math.round(((i + 1) / items.length) * 100),
              });
            } catch (err) {
              const errMsg =
                err instanceof Error ? err.message : "Unknown error";
              console.error(`Failed to fetch ${item.url}:`, err);

              // Add error placeholder in ZIP
              arc.append(
                Buffer.from(
                  `Failed to download: ${item.url}\nError: ${errMsg}\n`
                ),
                { name: `error_${i + 1}.txt` }
              );

              send({
                type: "file_error",
                index: i,
                filename: item.filename || `file_${i + 1}`,
                error: errMsg,
                total: items.length,
                current: i + 1,
                progress: Math.round(((i + 1) / items.length) * 100),
              });
            }
          }

          // Finalize ZIP
          send({ type: "zipping", message: "Building ZIP archive…" });
          arc.finalize();
          await zipReady;

          const zipBuffer = Buffer.concat(chunks);
          const zipName = generateZipName();

          send({
            type: "complete",
            filename: zipName,
            contentType: "application/zip",
            data: zipBuffer.toString("base64"),
            isZip: true,
          });

          saveToHistory(items);
        }
      } catch (err) {
        console.error("SSE download error:", err);
        send({
          type: "error",
          message: err instanceof Error ? err.message : "Internal error",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",       // Disable nginx buffering
      "X-Content-Type-Options": "nosniff",
      // Force HTTP/1.1 — SSE is incompatible with HTTP/2 multiplexing on some proxies
      // and breaks entirely over QUIC/HTTP3
      "Alt-Svc": "clear",
    },
  });
}

// ── POST: Main endpoint for downloads with SSE progress ─────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const items: DownloadItem[] = body.items ?? [];
    const forceZip: boolean = body.forceZip ?? false;
    const useSSE: boolean = body.useSSE ?? true; // Default to SSE for progress

    if (!items.length) {
      return NextResponse.json({ error: "No items provided." }, { status: 400 });
    }

    // Use SSE for progress updates (default behavior)
    if (useSSE) {
      return handleSSEDownload(items, forceZip);
    }

    // ── Single file, no zip ─────────────────────────────────────────────────
    if (items.length === 1 && !forceZip) {
      const item = items[0];
      try {
        const { buffer, contentType, filename } = await fetchMediaBuffer(
          item.url
        );
        const safeName = item.filename || filename;

        saveToHistory([item]);

        return new NextResponse(new Uint8Array(buffer), {
          status: 200,
          headers: {
            "Content-Type": contentType,
            "Content-Disposition": `attachment; filename="${encodeURIComponent(safeName)}"`,
            "Content-Length": String(buffer.length),
            "Cache-Control": "no-store",
          },
        });
      } catch (err) {
        console.error("Single download error:", err);
        return NextResponse.json(
          { error: "Failed to fetch the file." },
          { status: 502 }
        );
      }
    }

    // ── Multiple files → ZIP (sequential, no progress feedback) ────────────
    try {
      const archiver = (await import("archiver")).default;
      const arc = archiver("zip", { zlib: { level: 6 } });
      const chunks: Buffer[] = [];

      arc.on("data", (chunk: Buffer) => chunks.push(chunk));

      const zipReady = new Promise<void>((resolve, reject) => {
        arc.on("end", resolve);
        arc.on("error", reject);
      });

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        try {
          const { buffer, filename } = await fetchMediaBuffer(item.url);
          const safeName =
            item.filename ||
            filename ||
            `media_${i + 1}${path.extname(item.url.split("?")[0]) || ""}`;
          arc.append(buffer, { name: safeName });
        } catch (err) {
          arc.append(
            Buffer.from(
              `Failed to download: ${item.url}\nError: ${err instanceof Error ? err.message : "Unknown"}\n`
            ),
            { name: `error_${i + 1}.txt` }
          );
        }
      }

      arc.finalize();
      await zipReady;

      const zipBuffer = Buffer.concat(chunks);
      const zipName = generateZipName();

      saveToHistory(items);

      return new NextResponse(new Uint8Array(zipBuffer), {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${zipName}"`,
          "Content-Length": String(zipBuffer.length),
          "Cache-Control": "no-store",
        },
      });
    } catch (err) {
      console.error("ZIP build error:", err);
      return NextResponse.json(
        { error: "Failed to build ZIP." },
        { status: 502 }
      );
    }
  } catch (err) {
    console.error("Download route error:", err);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 }
    );
  }
}
