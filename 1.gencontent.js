const fs = require("fs");
const dotenv = require("dotenv");
const { google } = require("googleapis");
const OpenAI = require("openai").default;

dotenv.config();

const SHEET_URL = process.env.SHEET_URL;
const OPENAI_KEY = process.env.OPENAI_KEY;

const openai = new OpenAI({ apiKey: OPENAI_KEY });

// ----------- OAUTH AUTH -----------
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

// ---------------- HELPERS ----------------
function extractSheetId(url) {
  return url.match(/\/d\/([a-zA-Z0-9-_]+)/)[1];
}

async function generateGPT(model, prompt) {
  const res = await openai.chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }],
  });

  return res.choices[0].message.content.trim();
}

async function updateCell(sheetId, range, value) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [[value]] },
  });
}

// ---------------- MAIN LOGIC ----------------
async function run() {
  const sheetId = extractSheetId(SHEET_URL);

  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Sheet1!A2:F",
  });

  const rows = data.values;
  if (!rows || rows.length === 0) {
    console.log("No data found. Exiting.");
    return;
  }

  for (let i = 0; i < rows.length; i++) {
    const rowIndex = i + 2;
    const [
      company,
      website,
      topic,
      caption,
      hashtags,
      imagePrompt,
    ] = rows[i];

    if (!company && !website && !topic) {
      console.log("No new row detected, exiting.");
      break;
    }

    if (!company) {
      console.log(`Row ${rowIndex}: Company not found. Skipping.`);
      continue;
    }

    if (!topic) {
      console.log(`Row ${rowIndex}: Topic not found. Skipping.`);
      continue;
    }

    console.log(`Reading topic complete: ${topic}`);

    // -------- CAPTION --------
    if (!caption) {
      try {
        console.log(`Generating Caption for ${topic}`);
        const newCaption = await generateGPT(
          "gpt-5",
          `Write one single, professional social media caption for ${company} about "${topic}". 
Return ONLY the caption text.`
        );

        await updateCell(sheetId, `Sheet1!D${rowIndex}`, newCaption);
        console.log(`Caption saved for ${topic}`);
      } catch (err) {
        console.log(`Caption failed for ${topic}`, err.message);
      }
    }

    // -------- HASHTAGS --------
    if (!hashtags) {
      try {
        console.log(`Generating Hashtags for ${topic}`);
        const newHashtags = await generateGPT(
          "gpt-5-mini",
          `Generate exactly 10 relevant social media hashtags for "${topic}". 
Return ONLY hashtags separated by spaces.`
        );

        await updateCell(sheetId, `Sheet1!E${rowIndex}`, newHashtags);
        console.log(`Hashtags saved for ${topic}`);
      } catch (err) {
        console.log(`Hashtags failed for ${topic}`, err.message);
      }
    }

    // -------- IMAGE PROMPT --------
    if (!imagePrompt) {
      try {
        console.log(`Generating Image Prompt for ${topic}`);
        const newImagePrompt = await generateGPT(
          "gpt-5",
          `Write one single detailed AI image prompt for a social media post about "${topic}" for ${company}. Do not add any kind of text adding instructions in the prompt
Return ONLY the prompt.`
        );

        await updateCell(sheetId, `Sheet1!F${rowIndex}`, newImagePrompt);
        console.log(`Image Prompt saved for ${topic}`);
      } catch (err) {
        console.log(`Image Prompt failed for ${topic}`, err.message);
      }
    }

    console.log(`Completed all steps for ${topic}`);
    console.log("Going to next row");
  }
}

run().catch(console.error);
