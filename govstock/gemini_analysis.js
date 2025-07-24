import axios from 'axios';
import { TextGenerationModel } from '@google/genai';
import formidable from 'formidable';
import fs from 'fs';
import * as XLSX from 'xlsx';

// Disable Next.js default body parsing to handle file uploads
export const config = {
  api: {
    bodyParser: false,
  },
};

const gemini = new TextGenerationModel({
  apiKey: process.env.GEMINI_API_KEY,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const form = new formidable.IncomingForm();
  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error('Form parse error:', err);
      return res.status(400).json({ error: 'Invalid form data' });
    }

    const file = files.excel;
    if (!file) {
      return res.status(400).json({ error: 'Missing Excel file upload' });
    }

    try {
      // Read the workbook and first sheet
      const workbook = XLSX.readFile(file.filepath);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

      // Skip header row
      const dataRows = rows.slice(1);
      const results = [];

      for (const [name, description, pdfUrl, historyText] of dataRows) {
        if (!pdfUrl || !historyText) continue;

        // 1) Passage likelihood
        const likelihoodPrompt = `
Given the full bill text PDF at: ${pdfUrl}
and the legislative history below:
${historyText}

Assess the likelihood of this bill being passed by Congress. Provide a single integer percentage value between 1 and 99 inclusive, without any explanatory text or decimals.
`;
        const likelihoodResp = await gemini.generate({
          model: 'models/text-bison-001',
          prompt: likelihoodPrompt,
        });
        const rawLikelihood = likelihoodResp.text.trim();
        const likelihood = parseInt(rawLikelihood.replace(/\D/g, ''), 10);

        // 2) Impacted stocks
        const stocksPrompt = `
Given the same bill with PDF at: ${pdfUrl}
and its legislative history:
${historyText}

Identify the stocks most likely to be affected by the passage of this bill. Return a JSON array of objects with fields:
- symbol: stock ticker symbol
- impact: true if the stock is expected to go up, false if expected to go down

Example:
[
  { "symbol": "AAPL", "impact": true },
  { "symbol": "T", "impact": false }
]
Only include the JSON array in your response.
`;
        const stocksResp = await gemini.generate({
          model: 'models/text-bison-001',
          prompt: stocksPrompt,
        });
        const stocks = JSON.parse(stocksResp.text);

        results.push({
          name,
          description,
          pdfUrl,
          historyText,
          likelihood,
          stocks,
        });
      }

      res.status(200).json({ results });
    } catch (error) {
      console.error('Processing error:', error);
      res.status(500).json({ error: error.message });
    } finally {
      // Clean up uploaded file
      fs.unlink(file.filepath, () => {});
    }
  });
}
