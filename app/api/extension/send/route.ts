import { NextRequest, NextResponse } from "next/server";
import { DownloadItem } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10; // Fast endpoint — fail quickly rather than hanging

// CORS headers for extension requests from social media sites
const corsHeaders = {
  "Access-Control-Allow-Origin": "*", // Allow all origins (extension can be used on any site)
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400", // 24 hours
};

// In-memory store for extension-sent URLs (persists until server restart)
// In production, you'd use a database
// Queue holds pending items from extension - user must process them
let extensionQueue: DownloadItem[] = [];
// Processed items that have been fetched but not yet downloaded
let processedQueue: DownloadItem[] = [];

function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Handle OPTIONS preflight request
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { urls, media, type } = body;

    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return NextResponse.json(
        { success: false, error: "No URLs provided" },
        { status: 400, headers: corsHeaders }
      );
    }

    // Create download items from URLs
    const items: DownloadItem[] = urls.map((url: string, index: number) => {
      const mediaInfo = media?.[index];
      return {
        id: generateId(),
        url,
        filename: extractFilename(url, type || mediaInfo?.type, index),
        type: detectMediaType(url, mediaInfo?.type),
        thumbnail: mediaInfo?.thumbnail,
        status: "pending",
        platform: detectPlatform(url),
        source: "extension",
      };
    });

    // Add to extension queue (NOT to history yet - user must process them)
    extensionQueue.push(...items);

    return NextResponse.json(
      {
        success: true,
        count: items.length,
        queueCount: extensionQueue.length,
        message: `Added ${items.length} items to pending queue. Open Harveey to process.`,
      },
      { headers: corsHeaders }
    );
  } catch (error) {
    console.error("Extension send error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to process URLs" },
      { status: 500, headers: corsHeaders }
    );
  }
}

// Get pending items from extension queue (peek without clearing)
export async function GET() {
  // Return all pending items from extension queue
  const items = [...extensionQueue];
  
  return NextResponse.json(
    {
      success: true,
      items,
      count: items.length,
      hasNew: items.length > 0,
    },
    { headers: corsHeaders }
  );
}

// Mark items as processed (remove from queue after user downloads them)
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { itemIds } = body;

    if (!itemIds || !Array.isArray(itemIds)) {
      return NextResponse.json(
        { success: false, error: "No item IDs provided" },
        { status: 400, headers: corsHeaders }
      );
    }

    // Remove processed items from queue
    const processedItems = extensionQueue.filter(item => itemIds.includes(item.id));
    extensionQueue = extensionQueue.filter(item => !itemIds.includes(item.id));

    // Only save to history AFTER items are successfully processed
    if (processedItems.length > 0) {
      await saveToHistory(processedItems, "completed");
    }

    return NextResponse.json(
      {
        success: true,
        processedCount: processedItems.length,
        remainingCount: extensionQueue.length,
      },
      { headers: corsHeaders }
    );
  } catch (error) {
    console.error("Extension process error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to process items" },
      { status: 500, headers: corsHeaders }
    );
  }
}

function extractFilename(url: string, type?: string, index?: number): string {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const basename = pathname.split("/").pop();
    if (basename && basename.includes(".")) return basename;
  } catch {}

  const ext = type === "video" ? ".mp4" : type === "image" ? ".jpg" : "";
  return `harveey_${index ?? 0}${ext}`;
}

function detectMediaType(url: string, hintType?: string): "image" | "video" | "gif" | "unknown" {
  if (hintType) {
    if (hintType === "video") return "video";
    if (hintType === "image") return "image";
    if (hintType === "gif") return "gif";
  }

  const lower = url.toLowerCase();
  if (lower.includes(".mp4") || lower.includes(".webm") || lower.includes(".mov")) return "video";
  if (lower.includes(".gif")) return "gif";
  if (lower.includes(".jpg") || lower.includes(".jpeg") || lower.includes(".png") || lower.includes(".webp")) return "image";

  return "unknown";
}

function detectPlatform(url: string): string {
  try {
    const hostname = new URL(url).hostname.replace("www.", "");
    const platforms: Record<string, string> = {
      "instagram.com": "Instagram",
      "twitter.com": "Twitter",
      "x.com": "Twitter/X",
      "facebook.com": "Facebook",
      "reddit.com": "Reddit",
      "tiktok.com": "TikTok",
      "youtube.com": "YouTube",
      "youtu.be": "YouTube",
      "redgifs.com": "RedGIFs",
    };
    return platforms[hostname] || hostname;
  } catch {
    return "Unknown";
  }
}

// Simple file-based history storage
// Only saves items that have been successfully processed/downloaded
async function saveToHistory(items: DownloadItem[], status: string = "completed") {
  const fs = require("fs");
  const path = require("path");
  const historyPath = path.join(process.cwd(), ".harveey-history.json");

  let history: any[] = [];
  try {
    if (fs.existsSync(historyPath)) {
      const data = fs.readFileSync(historyPath, "utf-8");
      history = JSON.parse(data);
    }
  } catch {
    history = [];
  }

  // Add new items with provided status (only "completed" for successful downloads)
  const newHistory = items.map(item => ({
    id: item.id,
    url: item.url,
    filename: item.filename,
    type: item.type,
    platform: item.platform,
    thumbnail: item.thumbnail,
    status,
    timestamp: Date.now(),
    source: item.source || "extension",
  }));

  history = [...newHistory, ...history].slice(0, 500); // Keep last 500

  try {
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
  } catch (error) {
    console.error("Failed to save history:", error);
  }
}
