# AI Analyst — Setup

This build adds an AI Analyst panel backed by Google Gemini. The dashboard data is calculated in Flask first; the model receives a compact, authoritative context rather than the raw workbook.

## 1. Get a Gemini API key
Create a Gemini API key in Google AI Studio. Keep it private.

## 2. Local testing
Windows CMD:
```cmd
set GEMINI_API_KEY=YOUR_KEY_HERE
python app.py
```
Then open the dashboard and click **AI Analyst**.

## 3. Render
In Render → your Web Service → Environment add:
```text
GEMINI_API_KEY=YOUR_KEY_HERE
GEMINI_MODEL=gemini-2.5-flash
```
Redeploy. Do NOT put the key in `app.js`, HTML, GitHub, or a public file.

## What it knows
- Current Month vs LY Growth %
- NOD (days)
- Stock Qty / Stock Value depending on the dashboard Qty/Value toggle
- SKU and store rankings
- Pareto
- Variance metrics when available
- Current dashboard filters

## Important
The AI is instructed to stay data-only, avoid invented numbers, and distinguish recommendations from facts. It does not replace the dashboard's Python calculations.
