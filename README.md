# Content Automation Engine

## Overview

The Content Automation Engine is a comprehensive social media automation solution designed to streamline the lifecycle of content creation and publication. This system leverages advanced AI technologies and robust API integrations to facilitate the automated generation of text and imagery, media processing, and scheduled distribution to Facebook platforms. It allows for efficient management of content pipelines through a centralized Web Dashboard.

---

### Web Dashboard Preview

<p align="center">
  <img 
    src="https://i.ibb.co/Zp1jY8j8/Screenshot-2025-12-16-at-17-41-04-Content-Automation-Engine.png"
    alt="Content Automation Engine Web Dashboard"
    width="800"
  />
</p>

---


## Key Features

- **Automated Content Generation**: Utilizes OpenAI GPT models to synthesize high-quality text for social media posts.
- **Visual Asset Creation**: Integrates with DALL-E to generate relevant imagery based on content themes.
- **Advanced Media Processing**: Includes a dedicated pipeline for embedding corporate branding, logos, and dynamic text overlays onto visual assets.
- **Google Sheets Integration**: Seamlessly connects with Google Sheets for structured content planning, tracking, and data persistence.
- **Facebook Publishing Automation**: Automates the posting process to Facebook Pages via the Graph API, including token management.
- **Centralized Management Dashboard**: specific web interface for configuration, real-time workflow execution, scheduling, and system monitoring.

## System Requirements

- **Runtime Environment**: Node.js (Version 18.0.0 or higher recommended).
- **API Access**: Valid credentials for OpenAI, Google Cloud Platform (Sheets API), and Meta for Developers (Facebook Graph API).

## Installation

1.  Clone the repository to your local machine.
2.  Navigate to the project directory.
3.  Install the necessary dependencies using the Node Package Manager:

    ```bash
    npm install
    ```

## Configuration

The application requires specific environment variables to function correctly. These can be configured directly through the application's Web Dashboard or by manually creating a `.env` file in the root directory.

**Required Configuration Parameters:**
-   **Google Sheets**: `SHEET_URL`
-   **OpenAI**: `OPENAI_KEY`
-   **Facebook**: `FB_APPID`, `FB_APPSECRET`, `PAGE_ID`, `PAGE_TOKEN`
-   **Processing Settings**: `LOGO_SIZE`, `FONT_SIZE`

## Usage

To launch the Content Automation Engine, execute the following command:

```bash
npm start
```

This command initializes the local server and makes the Web Dashboard accessible, typically at `http://localhost:3000`.

### Workflow Execution

The system operates via a sequential pipeline. Operations can be triggered individually or as a complete workflow through the dashboard:

1.  **Initialize Layout**: Sets up the required structure in the connected Google Sheet.
2.  **Refresh Credentials**: Updates Facebook access tokens to ensure uninterrupted connectivity.
3.  **Generate Content**: Produces text drafts based on defined criteria.
4.  **Generate Imagery**: Creates visual assets corresponding to the text content.
5.  **Embed Branding**: Applies logos to the generated images.
6.  **Overlay Text**: Adds text overlays to the final media assets.
7.  **Publish**: Posts the finalized content to the designated Facebook Page.

### Scheduling

The application supports automated scheduling, allowing the full workflow to execute at defined intervals (e.g., every 60 minutes). This can be toggled and configured within the dashboard.

## Technical Architecture

The architecture is built upon a modular Node.js backend using Express.js. It employs a child-process pattern to execute heavy automation scripts, ensuring the stability and responsiveness of the main server application. Data persistence and state management are handled via local filesystem storage and Google Sheets integration.
