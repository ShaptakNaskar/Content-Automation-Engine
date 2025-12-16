/**
 * mainrunner.js - Master Pipeline Runner (Content Processing Only)
 * 
 * Runs scripts 1-4 only (skips authentication/token setup):
 * 1. Generate Content (GPT)
 * 2. Generate Images (DALL-E 3)
 * 3. Embed Logo
 * 4. Embed Text
 * 
 * Usage:
 *   node mainrunner.js --run-once           # Run all scripts once
 *   node mainrunner.js --schedule "* * * * *"  # Run on cron schedule
 */

require("dotenv").config();
const { spawn } = require("child_process");
const path = require("path");
const cron = require("node-cron");
const fs = require("fs");

// Color codes for console output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m"
};

// Pipeline configuration - ONLY steps 1-4
const PIPELINE = [
  {
    name: "Generate Content",
    file: "1.gencontent.js",
    optional: false,
    description: "Generate captions, hashtags, and image prompts using GPT"
  },
  {
    name: "Generate Images",
    file: "2.genimage.js",
    optional: false,
    description: "Generate images using DALL-E 3"
  },
  {
    name: "Embed Logo",
    file: "3.embedlogo.js",
    optional: false,
    description: "Embed company logo into generated images"
  },
  {
    name: "Embed Text",
    file: "4.embedtxt.js",
    optional: false,
    description: "Embed text overlays on images"
  },
  {
    name: "Post to Facebook",
    file: "5.post2fbgen3.js",
    optional: false,
    description: "Post generated content to Facebook Page"
  }
];

// Logger utility
function log(level, message) {
  const timestamp = new Date().toISOString();
  const prefix = {
    info: `${colors.cyan}[INFO]${colors.reset}`,
    success: `${colors.green}[SUCCESS]${colors.reset}`,
    warn: `${colors.yellow}[WARN]${colors.reset}`,
    error: `${colors.red}[ERROR]${colors.reset}`,
    task: `${colors.blue}[TASK]${colors.reset}`
  };

  console.log(`${prefix[level] || prefix.info} ${timestamp} | ${message}`);
}

// Run a single script
async function runScript(scriptConfig) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, scriptConfig.file);

    if (!fs.existsSync(scriptPath)) {
      reject(new Error(`Script not found: ${scriptPath}`));
      return;
    }

    log("task", `Starting: ${scriptConfig.name}`);
    log("info", `Description: ${scriptConfig.description}`);

    const process = spawn("node", [scriptPath], {
      stdio: "inherit",
      cwd: __dirname
    });

    process.on("close", (code) => {
      if (code === 0) {
        log("success", `Completed: ${scriptConfig.name}`);
        resolve();
      } else {
        const error = new Error(
          `${scriptConfig.name} failed with exit code ${code}`
        );
        if (scriptConfig.optional) {
          log("warn", error.message);
          resolve(); // Don't reject for optional scripts
        } else {
          reject(error);
        }
      }
    });

    process.on("error", (error) => {
      reject(new Error(`Failed to run ${scriptConfig.name}: ${error.message}`));
    });
  });
}

// Run entire pipeline
async function runPipeline(mode = "once") {
  log("info", `========================================`);
  log("info", `Content Processing Pipeline (Steps 1-4)`);
  log("info", `Mode: ${mode}`);
  log("info", `========================================`);

  const startTime = Date.now();
  let successCount = 0;
  let failCount = 0;

  for (const script of PIPELINE) {
    try {
      await runScript(script);
      successCount++;
    } catch (error) {
      failCount++;
      log("error", error.message);

      if (!script.optional) {
        log("error", "Pipeline halted due to critical failure");
        return { success: false, successCount, failCount, totalTime: Date.now() - startTime };
      }
    }

    // Add delay between scripts to avoid rate limiting
    if (PIPELINE.indexOf(script) < PIPELINE.length - 1) {
      log("info", "Waiting 2 seconds before next task...");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  const totalTime = Date.now() - startTime;
  log("success", `Pipeline execution complete!`);
  log("info", `Successful: ${successCount} | Failed: ${failCount}`);
  log("info", `Total time: ${(totalTime / 1000).toFixed(2)} seconds`);

  return { success: failCount === 0, successCount, failCount, totalTime };
}

// Schedule pipeline to run periodically
function scheduleExecution(cronExpression) {
  log("info", `Scheduling pipeline to run: "${cronExpression}"`);

  const task = cron.schedule(cronExpression, async () => {
    log("info", `Cron triggered execution at ${new Date().toISOString()}`);
    try {
      await runPipeline("scheduled");
    } catch (error) {
      log("error", `Scheduled execution failed: ${error.message}`);
    }
  });

  log("success", "Scheduler started. Press Ctrl+C to stop.");
  return task;
}

// Parse command-line arguments
function parseArguments() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--run-once") {
    return { mode: "once" };
  }

  if (args[0] === "--schedule" && args[1]) {
    return { mode: "schedule", cronExpression: args[1] };
  }

  if (args[0] === "--help" || args[0] === "-h") {
    return { mode: "help" };
  }

  return { mode: "invalid" };
}

// Display help
function displayHelp() {
  console.log(`
${colors.bright}Content Processing Pipeline Runner (Steps 1-4)${colors.reset}

${colors.cyan}Usage:${colors.reset}
  node mainrunner.js [OPTIONS]

${colors.cyan}Options:${colors.reset}
  --run-once                    Run pipeline once and exit (default)
  --schedule "CRON_EXPRESSION"  Run pipeline on a schedule
  --help, -h                    Display this help message

${colors.cyan}Examples:${colors.reset}
  # Run once
  node mainrunner.js --run-once

  # Run every day at 9 AM
  node mainrunner.js --schedule "0 9 * * *"

  # Run every 6 hours
  node mainrunner.js --schedule "0 */6 * * *"

  # Run every Monday at 8 AM
  node mainrunner.js --schedule "0 8 * * 1"

${colors.cyan}Cron Expression Format:${colors.reset}
  ┌───────────── minute (0 - 59)
  │ ┌───────────── hour (0 - 23)
  │ │ ┌───────────── day of month (1 - 31)
  │ │ │ ┌───────────── month (1 - 12)
  │ │ │ │ ┌───────────── day of week (0 - 6) (0 = Sunday)
  │ │ │ │ │
  │ │ │ │ │
  * * * * *

${colors.cyan}Pipeline Steps (1-4 only):${colors.reset}
  `);

  PIPELINE.forEach((step, idx) => {
    console.log(`  ${idx + 1}. ${colors.green}${step.name}${colors.reset}`);
    console.log(`     ${step.description}`);
  });

  console.log(`
${colors.cyan}Notes:${colors.reset}
  - Scripts 0, 0.1, 0.2 (OAuth, sheet init, FB token) are excluded
  - Run these setup scripts separately only once:
    npm run oauth
    npm run sheet:init
    npm run fb:refresh
  - Each script must complete successfully to proceed
  - Check .env file for required environment variables
  - To Post in facebook, run npm run fb:post
  `);
}

// Main entry point
async function main() {
  const { mode, cronExpression } = parseArguments();

  if (mode === "help") {
    displayHelp();
    return;
  }

  if (mode === "invalid") {
    log("error", "Invalid arguments");
    displayHelp();
    process.exit(1);
  }

  if (mode === "once") {
    try {
      const result = await runPipeline("once");
      process.exit(result.success ? 0 : 1);
    } catch (error) {
      log("error", `Fatal error: ${error.message}`);
      process.exit(1);
    }
  }

  if (mode === "schedule") {
    try {
      // Validate cron expression
      const testTask = cron.schedule(cronExpression, () => { }, {
        scheduled: false
      });

      // Run once immediately, then schedule
      log("info", "Running pipeline immediately...");
      await runPipeline("scheduled");

      // Then schedule for future runs
      scheduleExecution(cronExpression);

      // Keep process alive
      process.on("SIGINT", () => {
        log("info", "Scheduler stopped");
        process.exit(0);
      });
    } catch (error) {
      log("error", `Invalid cron expression: ${error.message}`);
      displayHelp();
      process.exit(1);
    }
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { runPipeline, runScript, scheduleExecution };
