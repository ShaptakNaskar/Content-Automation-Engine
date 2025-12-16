const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { google } = require("googleapis");
const OpenAI = require("openai").default;

dotenv.config();

const SHEET_URL = process.env.SHEET_URL;
const OPENAI_KEY = process.env.OPENAI_KEY;

const openai = new OpenAI({ apiKey: OPENAI_KEY });

// ---------------- OAUTH ----------------
const CREDENTIALS = JSON.parse(fs.readFileSync("credentials.json"));
const TOKEN = JSON.parse(fs.readFileSync("token.json"));

const { client_secret, client_id, redirect_uris } =
  CREDENTIALS.installed || CREDENTIALS.web;

const oAuth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  redirect_uris[0]
);

oAuth2Client.setCredentials(TOKEN);

const sheets = google.sheets({ version: "v4", auth: oAuth2Client });
const drive = google.drive({ version: "v3", auth: oAuth2Client });

// ---------------- HELPERS ----------------
function extractSheetId(url) {
  return url.match(/\/d\/([a-zA-Z0-9-_]+)/)[1];
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

async function getOrCreateFolder(folderName) {
  console.log(`Checking for Google Drive folder: ${folderName}`);

  const res = await drive.files.list({
    q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id, name)",
  });

  if (res.data.files.length > 0) {
    console.log("Folder found");
    return res.data.files[0].id;
  }

  console.log("Folder not found. Creating folder.");

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
  console.log("Uploading image to Google Drive");

  const fileMetadata = {
    name: fileName,
    parents: [folderId],
  };

  const media = {
    mimeType: "image/png",
    body: fs.createReadStream(filePath),
  };

  const file = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: "id",
  });

  await drive.permissions.create({
    fileId: file.data.id,
    requestBody: {
      role: "reader",
      type: "anyone",
    },
  });

  const result = await drive.files.get({
    fileId: file.data.id,
    fields: "webViewLink",
  });

  console.log("Upload completed and public link created");
  return result.data.webViewLink;
}

async function downloadImage(url, outputPath) {
  console.log("Downloading image from OpenAI URL");

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Image download failed with status ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  fs.writeFileSync(outputPath, buffer);

  console.log("Image downloaded locally");
}


async function generateImage(prompt) {
  console.log("Calling DALL E 3");

  const result = await openai.images.generate({
    model: "dall-e-3",
    prompt,
    size: "1024x1024",
  });

  return result.data[0].url;
}

// ---------------- MAIN LOGIC ----------------
async function run() {
  const sheetId = extractSheetId(SHEET_URL);
  const folderId = await getOrCreateFolder("AutoFb");

  console.log("Reading header row");

  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Sheet1!A1:Z1",
  });

  const headers = headerRes.data.values[0];

  const imagePromptCol = headers.indexOf("ImagePrompt");
  const genImageCol = headers.indexOf("GenImage");
  const genCompleteCol = headers.indexOf("GenComplete");

  if (imagePromptCol === -1 || genImageCol === -1 || genCompleteCol === -1) {
    console.log("Required columns not found in headers.");
    console.log("Required: ImagePrompt, GenImage, GenComplete");
    process.exit(1);
  }

  console.log("Columns detected:");
  console.log(`ImagePrompt: ${imagePromptCol + 1}`);
  console.log(`GenImage: ${genImageCol + 1}`);
  console.log(`GenComplete: ${genCompleteCol + 1}`);

  console.log("Reading sheet rows");

  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Sheet1!A2:Z",
  });

  const rows = data.values;
  if (!rows || rows.length === 0) {
    console.log("No rows found. Exiting.");
    return;
  }

  for (let i = 0; i < rows.length; i++) {
    const rowIndex = i + 2;
    const row = rows[i];

    const imagePrompt = row[imagePromptCol];
    const genImage = row[genImageCol];
    const genComplete = row[genCompleteCol];

    if (!imagePrompt) {
      console.log(`Row ${rowIndex}: No ImagePrompt. Skipping.`);
      continue;
    }

    if (genComplete === "Complete") {
      console.log(`Row ${rowIndex}: Already completed. Skipping.`);
      continue;
    }

    console.log(`Processing row ${rowIndex}`);
    console.log(`Image Prompt: ${imagePrompt}`);

    try {
      const imageUrl = await generateImage(imagePrompt);

      const localFile = path.join(
        __dirname,
        `temp_${rowIndex}_${Date.now()}.png`
      );

      await downloadImage(imageUrl, localFile);

      const driveLink = await uploadToDrive(
        folderId,
        localFile,
        path.basename(localFile)
      );

      fs.unlinkSync(localFile);

      await updateCell(sheetId, genImageCol, rowIndex, driveLink);
      await updateCell(sheetId, genCompleteCol, rowIndex, "Complete");

      console.log(`Row ${rowIndex}: Image generated and uploaded successfully`);
      console.log("Moving to next row");
    } catch (err) {
      const errorMsg = `Error: ${err.message}`;

      console.log(`Row ${rowIndex} failed`);
      console.log(errorMsg);

      await updateCell(sheetId, genCompleteCol, rowIndex, errorMsg);
    }
  }

  console.log("All rows processed");
}

run().catch(console.error);
