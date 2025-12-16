const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const dotenv = require("dotenv");
const { google } = require("googleapis");

dotenv.config();

const SHEET_URL = process.env.SHEET_URL;

// ---------------- AUTH ----------------
const CREDENTIALS = JSON.parse(fs.readFileSync("credentials.json"));
const TOKEN = JSON.parse(fs.readFileSync("token.json"));

const { client_secret, client_id, redirect_uris } =
  CREDENTIALS.installed || CREDENTIALS.web;

const auth = new google.auth.OAuth2(
  client_id,
  client_secret,
  redirect_uris[0]
);

auth.setCredentials(TOKEN);

const sheets = google.sheets({ version: "v4", auth });
const drive = google.drive({ version: "v3", auth });

// ---------------- HELPERS ----------------
function extractSheetId(url) {
  return url.match(/\/d\/([a-zA-Z0-9-_]+)/)[1];
}

function normalizeHeader(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/\(.*?\)/g, "");
}

function columnNumberToLetter(num) {
  let letter = "";
  while (num > 0) {
    const mod = (num - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    num = Math.floor((num - mod) / 26);
  }
  return letter;
}

async function updateCell(sheetId, colIndex, rowIndex, value) {
  const colLetter = columnNumberToLetter(colIndex + 1);
  const range = `Sheet1!${colLetter}${rowIndex}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [[value]] },
  });
}

function toDirectDriveDownload(url) {
  if (!url) return url;
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) return url;
  return `https://drive.google.com/uc?export=download&id=${match[1]}`;
}

async function downloadFile(url, outputBasePath) {
  const directUrl = toDirectDriveDownload(url);
  console.log(`Downloading: ${directUrl}`);

  const res = await fetch(directUrl);
  if (!res.ok) throw new Error(`Download failed with status ${res.status}`);

  const contentType = res.headers.get("content-type") || "";
  let ext = "png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) ext = "jpg";

  const finalPath = `${outputBasePath}.${ext}`;
  const buffer = Buffer.from(await res.arrayBuffer());

  fs.writeFileSync(finalPath, buffer);
  console.log(`Saved: ${finalPath}`);

  return finalPath;
}

async function getOrCreateFolder(folderName) {
  console.log(`Checking Drive folder: ${folderName}`);

  const res = await drive.files.list({
    q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id)",
  });

  if (res.data.files.length > 0) {
    console.log("Folder found");
    return res.data.files[0].id;
  }

  console.log("Folder not found. Creating.");

  const folder = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
    },
    fields: "id",
  });

  console.log("Folder created");
  return folder.data.id;
}

async function uploadToDrive(folderId, filePath, fileName) {
  console.log("Uploading final image to Drive");

  const file = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: { mimeType: "image/png", body: fs.createReadStream(filePath) },
    fields: "id",
  });

  await drive.permissions.create({
    fileId: file.data.id,
    requestBody: { role: "reader", type: "anyone" },
  });

  const result = await drive.files.get({
    fileId: file.data.id,
    fields: "webViewLink",
  });

  console.log("Upload complete");
  return result.data.webViewLink;
}

function normalizePosition(raw) {
  if (!raw) return "TopCenter";

  const v = raw.toLowerCase().replace(/\s+/g, "").replace(/\//g, "");

  if (v === "middle" || v === "center") return "Center";
  if (v === "top" || v === "topcenter") return "TopCenter";
  if (v === "bottom" || v === "bottomcenter") return "BottomCenter";
  if (v === "topleft") return "TopLeft";
  if (v === "topright") return "TopRight";
  if (v === "centerleft") return "CenterLeft";
  if (v === "centerright") return "CenterRight";
  if (v === "bottomleft") return "BottomLeft";
  if (v === "bottomright") return "BottomRight";

  return "TopCenter";
}

function computePosition(baseW, baseH, logoW, logoH, pos) {
  const margin = 30;

  const x = {
    Left: margin,
    Center: Math.round((baseW - logoW) / 2),
    Right: baseW - logoW - margin,
  };

  const y = {
    Top: margin,
    Center: Math.round((baseH - logoH) / 2),
    Bottom: baseH - logoH - margin,
  };

  if (pos === "TopLeft") return { left: x.Left, top: y.Top };
  if (pos === "TopCenter") return { left: x.Center, top: y.Top };
  if (pos === "TopRight") return { left: x.Right, top: y.Top };
  if (pos === "CenterLeft") return { left: x.Left, top: y.Center };
  if (pos === "Center") return { left: x.Center, top: y.Center };
  if (pos === "CenterRight") return { left: x.Right, top: y.Center };
  if (pos === "BottomLeft") return { left: x.Left, top: y.Bottom };
  if (pos === "BottomCenter") return { left: x.Center, top: y.Bottom };
  if (pos === "BottomRight") return { left: x.Right, top: y.Bottom };

  return { left: x.Center, top: y.Top };
}

// ---------------- MAIN ----------------
async function run() {
  const sheetId = extractSheetId(SHEET_URL);
  const folderId = await getOrCreateFolder("AutoFb");

  console.log("Reading header row");

  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Sheet1!A1:Z1",
  });

  const headers = headerRes.data.values[0];
  const normalized = headers.map(normalizeHeader);

  const col = (name) => normalized.indexOf(normalizeHeader(name));

  const embedCol = col("EmbedLogo");
  const logoUrlCol = col("LogoUrl");
  const logoPosCol = col("LogoPosition");
  const completeCol = col("LogoEmbedComplete");
  const outputCol = col("ImageWithLogoEmbedded");
  const genImageCol = col("GenImage");

  if (
    [embedCol, logoUrlCol, logoPosCol, completeCol, outputCol, genImageCol].some(
      (c) => c === -1
    )
  ) {
    console.log("Required headers missing. Aborting.");
    process.exit(1);
  }

  console.log("Headers detected successfully");

  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Sheet1!A2:Z",
  });

  const rows = data.values || [];

  for (let i = 0; i < rows.length; i++) {
    const rowIndex = i + 2;
    const row = rows[i] || [];

    const embed = (row[embedCol] || "").toLowerCase();
    const logoUrl = row[logoUrlCol];
    const logoPosRaw = row[logoPosCol];
    const status = (row[completeCol] || "").toLowerCase();
    const baseImageUrl = row[genImageCol];

    console.log(`Processing row ${rowIndex}`);

    if (status === "complete") {
      console.log("Already complete. Skipping.");
      continue;
    }

    if (embed !== "yes") {
      console.log("EmbedLogo is not yes. Marking Complete.");
      await updateCell(sheetId, completeCol, rowIndex, "Complete");
      continue;
    }

    if (!baseImageUrl) {
      const msg = "Error: Base image (GenImage) missing";
      console.log(msg);
      await updateCell(sheetId, completeCol, rowIndex, msg);
      continue;
    }

    if (!logoUrl) {
      const msg = "Error: LogoUrl missing";
      console.log(msg);
      await updateCell(sheetId, completeCol, rowIndex, msg);
      continue;
    }

    const logoPos = normalizePosition(logoPosRaw);

    const baseBase = path.join(__dirname, `base_${rowIndex}`);
    const logoBase = path.join(__dirname, `logo_${rowIndex}`);
    const resizedLogoPath = path.join(__dirname, `logo_rs_${rowIndex}.png`);
    const finalPath = path.join(__dirname, `final_${rowIndex}.png`);

    let basePath, logoPath;

    try {
      basePath = await downloadFile(baseImageUrl, baseBase);
      logoPath = await downloadFile(logoUrl, logoBase);

      console.log("Validating logo format");
      const logoMeta = await sharp(logoPath).metadata();
      if (!["jpeg", "png"].includes(logoMeta.format)) {
        throw new Error("Logo must be PNG or JPEG");
      }

      const baseMeta = await sharp(basePath).metadata();
      const LOGO_SIZE = Number(process.env.LOGO_SIZE) || 0.30;
const targetLogoWidth = Math.round(baseMeta.width * LOGO_SIZE);


      console.log("Resizing logo");
      await sharp(logoPath)
        .resize({ width: targetLogoWidth })
        .png()
        .toFile(resizedLogoPath);

      const resizedMeta = await sharp(resizedLogoPath).metadata();
      const pos = computePosition(
        baseMeta.width,
        baseMeta.height,
        resizedMeta.width,
        resizedMeta.height,
        logoPos
      );

      console.log("Embedding logo");
      await sharp(basePath)
        .composite([{ input: resizedLogoPath, left: pos.left, top: pos.top }])
        .png()
        .toFile(finalPath);

      const driveLink = await uploadToDrive(
        folderId,
        finalPath,
        path.basename(finalPath)
      );

      await updateCell(sheetId, outputCol, rowIndex, driveLink);
      await updateCell(sheetId, completeCol, rowIndex, "Complete");

      console.log("Row completed successfully");
    } catch (err) {
      const msg = `Error: ${err.message}`;
      console.log(msg);
      await updateCell(sheetId, completeCol, rowIndex, msg);
    } finally {
      [basePath, logoPath, resizedLogoPath, finalPath].forEach((p) => {
        try {
          if (p && fs.existsSync(p)) fs.unlinkSync(p);
        } catch (e) {
          console.log(`Cleanup warning for ${p}: ${e.message}`);
        }
      });
    }
  }

  console.log("All rows processed");
}

run().catch(console.error);
