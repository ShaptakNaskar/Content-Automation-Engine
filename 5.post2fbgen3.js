/**
 * Full Rewritten 6.post2fbgen3.js
 * 
 * - Header-aware (dynamic width, supports any sheet column order)
 * - Skip rows already completed (PostStatus = posted/scheduled OR AllProcessComplete = yes)
 * - Media priority selection:
 *      1. NewImageLink
 *      2. ImageWithTextEmbedded
 *      3. ImageWithLogoEmbedded
 *      4. GenImage
 * - Strict DD/MM/YY date validation (month > 12 fails the row)
 * - IST → UTC unix timestamp conversion corrected
 * - Uses PAGE_TOKEN for posting (no APPID|APPSECRET posting)
 * - Heavy verbose logging
 * - No emojis
 */

require("dotenv").config();
const { google } = require("googleapis");
const axios = require("axios");
const path = require("path");
const fs = require("fs").promises;
const FormData = require("form-data");

/* ------------------- Logging Helper ------------------- */

function log(...args) {
  try {
    console.log(...args);
  } catch {
    console.log(String(args));
  }
}

/* ------------------- Column Helper ------------------- */

function toColLetter(colIndex) {
  let s = "";
  let n = colIndex + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/* ------------------- Google Auth ------------------- */

async function authenticateGoogle() {
  log("Authenticating with Google API");
  const token = JSON.parse(await fs.readFile(path.join(__dirname, "token.json"), "utf8"));
  const credentials = JSON.parse(await fs.readFile(path.join(__dirname, "credentials.json"), "utf8"));

  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
  const client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  client.setCredentials(token);
  log("Google authentication complete");
  return client;
}

/* ------------------- Drive Download ------------------- */

async function downloadFileFromDrive(link) {
  log("Downloading file:", link);

  const match = link.match(/\/file\/d\/([A-Za-z0-9_-]+)/) || link.match(/id=([A-Za-z0-9_-]+)/);
  if (!match) throw new Error("Invalid Google Drive link format");

  const fileId = match[1];
  const url = `https://drive.google.com/uc?export=download&id=${fileId}`;

  const res = await axios.get(url, { responseType: "arraybuffer", timeout: 180000 });
  const type = res.headers["content-type"] || "";

  log("Downloaded content-type:", type);

  if (!type.startsWith("image/") && !type.startsWith("video/")) {
    throw new Error("Unsupported file type: " + type);
  }

  return { data: res.data, contentType: type };
}

/* ------------------- Facebook Posting ------------------- */

async function postPhotoToFacebook(pageId, pageToken, fileData, contentType, message, scheduled, publishTime) {
  const url = `https://graph.facebook.com/v18.0/${pageId}/photos`;
  log("Posting photo →", url);

  const form = new FormData();
  form.append("source", fileData, { filename: "img.jpg", contentType });
  form.append("message", message);
  form.append("access_token", pageToken);

  if (scheduled) {
    form.append("published", "false");
    form.append("scheduled_publish_time", String(publishTime));
    log("Scheduled publish_time:", publishTime);
  }

  const res = await axios.post(url, form, { headers: form.getHeaders(), timeout: 200000 });
  log("FB photo POST status:", res.status);
  return res.data;
}

async function postVideoToFacebook(pageId, pageToken, fileData, contentType, message, scheduled, publishTime) {
  const url = `https://graph.facebook.com/v18.0/${pageId}/videos`;
  log("Posting video →", url);

  const form = new FormData();
  form.append("source", fileData, { filename: "video.mp4", contentType });
  form.append("description", message);
  form.append("access_token", pageToken);

  if (scheduled) {
    form.append("published", "false");
    form.append("scheduled_publish_time", String(publishTime));
    log("Scheduled publish_time:", publishTime);
  }

  const res = await axios.post(url, form, { headers: form.getHeaders(), timeout: 300000 });
  log("FB video POST status:", res.status);
  return res.data;
}

/* ------------------- Time Parsing ------------------- */

function parseFlexibleTime(str) {
  const s = String(str).trim().toUpperCase();
  const ampm = s.endsWith("AM") || s.endsWith("PM") ? s.slice(-2) : null;
  const base = ampm ? s.slice(0, -2).trim() : s;

  const parts = base.split(":").map(x => parseInt(x.trim(), 10));
  if (parts.length < 2) throw new Error("Invalid time format: " + str);

  let [h, m, sec] = [parts[0], parts[1], parts[2] || 0];

  if (ampm) {
    if (ampm === "PM" && h < 12) h += 12;
    if (ampm === "AM" && h === 12) h = 0;
  }

  return { h, m, s: sec };
}

function convertISTToUTCUnix(dateStr, timeStr) {
  const [d, m, yRaw] = dateStr.split("/").map(x => parseInt(x.trim(), 10));
  const y = yRaw < 100 ? 2000 + yRaw : yRaw;

  if (m > 12) throw new Error("Invalid DD/MM date: month > 12");

  const { h, m: mm, s } = parseFlexibleTime(timeStr);

  // IST offset
  const IST_OFFSET_MIN = 330;

  const istUTCms = Date.UTC(y, m - 1, d, h, mm, s);
  const utcMs = istUTCms - IST_OFFSET_MIN * 60 * 1000;

  const unix = Math.floor(utcMs / 1000);
  log("IST → UTC unix:", unix);
  return unix;
}

/* ------------------- MAIN SCRIPT ------------------- */

async function main() {
  log("Starting script...");

  const PAGE_ID = process.env.PAGE_ID;
  const PAGE_TOKEN = process.env.PAGE_TOKEN;
  const SHEET_URL = process.env.SHEET_URL;
  const DRY_RUN = process.argv.includes("--dry-run");

  if (!SHEET_URL) {
    log("Missing SHEET_URL. Exiting.");
    return;
  }

  const auth = await authenticateGoogle();
  const sheets = google.sheets({ version: "v4", auth });

  const match = SHEET_URL.match(/\/d\/([A-Za-z0-9_-]+)/);
  if (!match) {
    log("Invalid Google Sheet URL.");
    return;
  }
  const sheetId = match[1];

  log("Fetching full sheet...");
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Sheet1"
  });

  const rows = res.data.values || [];
  if (!rows.length) {
    log("Sheet is empty.");
    return;
  }

  const headers = rows[0].map(h => String(h).trim());
  const headerIndex = {};
  headers.forEach((h, i) => headerIndex[h] = i);

  log("Headers detected:", headers);

  const get = (row, name) => {
    const idx = headerIndex[name];
    return idx !== undefined && row[idx] != null ? String(row[idx]).trim() : "";
  };

  // Helper for immediate updates
  const updateSheet = async (rowNum, colName, value) => {
    if (!(colName in headerIndex)) return;
    const range = `Sheet1!${toColLetter(headerIndex[colName])}${rowNum}`;
    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: range,
        valueInputOption: "RAW",
        requestBody: { values: [[value]] }
      });
      // log(`Updated ${colName} for row ${rowNum} -> ${value}`);
    } catch (e) {
      log(`Failed to update sheet (${colName}):`, e.message);
    }
  };

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 1;

    log("---------------------------------------------------");
    log("Processing row:", rowNum);

    const postFlag = get(row, "Post(yes/no)").toLowerCase();
    const postStatus = get(row, "PostStatus").toLowerCase();
    const allDone = get(row, "AllProcessComplete").toLowerCase();

    // Skip if completed earlier
    if (postStatus === "posted" || postStatus === "scheduled" || allDone === "yes") {
      log("Row already complete. Skipping.");
      continue;
    }

    // If user set Post=no
    if (postFlag !== "yes") {
      log("Post=no detected. Marking as complete.");
      await updateSheet(rowNum, "PostStatus", "Post turned off");
      await updateSheet(rowNum, "AllProcessComplete", "yes");
      continue;
    }

    // If Facebook env missing, skip row
    if (!PAGE_ID || !PAGE_TOKEN) {
      log("Missing PAGE_ID or PAGE_TOKEN. Skipping this row.");
      await updateSheet(rowNum, "PostStatus", "no env vars set, exiting");
      await updateSheet(rowNum, "AllProcessComplete", "yes");
      continue;
    }

    const caption = get(row, "Caption");
    const hashtags = get(row, "Hashtags");
    const postDate = get(row, "PostDate(DD/MM/YY)");
    const postTime = get(row, "PostTime(HH:MM AM/PM)");

    if (!caption) {
      log("Caption missing. Failing row.");
      await updateSheet(rowNum, "PostStatus", "failed: caption blank");
      await updateSheet(rowNum, "AllProcessComplete", "yes");
      continue;
    }

    if (!hashtags) {
      log("Hashtags missing. Failing row.");
      await updateSheet(rowNum, "PostStatus", "failed: hashtags blank");
      await updateSheet(rowNum, "AllProcessComplete", "yes");
      continue;
    }

    if (!postDate || !postTime) {
      log("Missing date/time. Failing row.");
      await updateSheet(rowNum, "PostStatus", "failed: missing date/time");
      await updateSheet(rowNum, "AllProcessComplete", "yes");
      continue;
    }

    // Validate date format DD/MM
    const dateParts = postDate.split("/");
    if (dateParts.length !== 3) {
      log("Invalid date format.");
      await updateSheet(rowNum, "PostStatus", "failed: invalid date format");
      await updateSheet(rowNum, "AllProcessComplete", "yes");
      continue;
    }

    const dd = parseInt(dateParts[0]);
    const mm = parseInt(dateParts[1]);
    if (mm > 12) {
      log("Invalid month > 12. Rejecting date.");
      await updateSheet(rowNum, "PostStatus", "failed: invalid date format");
      await updateSheet(rowNum, "AllProcessComplete", "yes");
      continue;
    }

    // Media priority select
    const mediaLinks = [
      get(row, "NewImageLink"),
      get(row, "ImageWithTextEmbedded"),
      get(row, "ImageWithLogoEmbedded"),
      get(row, "GenImage")
    ];

    const media = mediaLinks.find(x => x);
    if (!media) {
      log("No media found. Failing row.");
      await updateSheet(rowNum, "PostStatus", "failed: no media link");
      await updateSheet(rowNum, "AllProcessComplete", "yes");
      continue;
    }

    log("Selected media:", media);

    // Download
    let fileData, contentType;
    try {
      const d = await downloadFileFromDrive(media);
      fileData = d.data;
      contentType = d.contentType;
    } catch (err) {
      log("Download error:", err.message);
      await updateSheet(rowNum, "PostStatus", "failed: download error");
      await updateSheet(rowNum, "AllProcessComplete", "yes");
      continue;
    }

    // Compute publish timestamp
    let publishUnix;
    try {
      publishUnix = convertISTToUTCUnix(postDate, postTime);
    } catch (err) {
      log("Date conversion error:", err.message);
      await updateSheet(rowNum, "PostStatus", "failed: invalid date/time");
      await updateSheet(rowNum, "AllProcessComplete", "yes");
      continue;
    }

    const nowUnix = Math.floor(Date.now() / 1000);
    const shouldSchedule = publishUnix - nowUnix > 600;

    const isImage = contentType.startsWith("image/");
    const isVideo = contentType.startsWith("video/");
    const message = `${caption} ${hashtags}`.trim();

    if (DRY_RUN) {
      log("Dry-run mode. Would", shouldSchedule ? "schedule" : "post now");
      await updateSheet(rowNum, "PostStatus", `dry-run: ${shouldSchedule ? "scheduled" : "posted"}`);
      continue;
    }

    try {
      if (shouldSchedule) {
        log("Scheduling post...");
        if (isImage)
          await postPhotoToFacebook(PAGE_ID, PAGE_TOKEN, fileData, contentType, message, true, publishUnix);
        else
          await postVideoToFacebook(PAGE_ID, PAGE_TOKEN, fileData, contentType, message, true, publishUnix);

        await updateSheet(rowNum, "PostStatus", "scheduled");

      } else {
        log("Posting now...");
        if (isImage)
          await postPhotoToFacebook(PAGE_ID, PAGE_TOKEN, fileData, contentType, message, false);
        else
          await postVideoToFacebook(PAGE_ID, PAGE_TOKEN, fileData, contentType, message, false);

        await updateSheet(rowNum, "PostStatus", "posted");
      }

      await updateSheet(rowNum, "AllProcessComplete", "yes");

    } catch (err) {
      log("Posting error:", err.message);
      if (err.response && err.response.data) {
        log("FB API error:", JSON.stringify(err.response.data, null, 2));
      }

      const fbMsg = err.response?.data?.error?.message || err.message;
      await updateSheet(rowNum, "PostStatus", `failed: ${String(fbMsg).slice(0, 200)}`);
      await updateSheet(rowNum, "AllProcessComplete", "yes");
    }
  }

  log("Script complete.");
}

if (require.main === module) {
  main().catch(e => {
    log("Fatal error:", e.message);
    process.exit(1);
  });
}
