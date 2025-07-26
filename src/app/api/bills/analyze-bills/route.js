import axios from 'axios';
import { TextGenerationModel } from '@google/genai';
import formidable from 'formidable';
import fs from 'fs';
import * as XLSX from 'xlsx';

// Disable Next.js default body parsing to handle file uploads
export const config = {
  api: { bodyParser: false },
};

const gemini = new TextGenerationModel({
  apiKey: process.env.GEMINI_API_KEY,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end('Method not allowed');
    return;
  }

  const form = new formidable.IncomingForm();
  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error('Form parse error:', err);
      res.status(400).json({ error: 'Invalid form data' });
      return;
    }

    const file = files.excel;
    if (!file) {
      res.status(400).json({ error: 'Missing Excel file upload' });
      return;
    }

    try {
      // Read workbook and first sheet
      const workbook = XLSX.readFile(file.filepath);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

      // Process each data row (skip header row)
      for (let i = 1; i < rows.length; i++) {
        const [name, description, pdfUrl, historyText] = rows[i];
        if (!pdfUrl || !historyText) continue;

        // 1) Passage likelihood
        const likelihoodPrompt = `
Given the full bill text PDF at: ${pdfUrl}
and the legislative history below:
${historyText}

Assess the likelihood of this bill being passed by Congress. Provide a single integer percentage value between 1 and 99 inclusive, without any explanatory text or decimals.
`;
        const likelihoodResp = await gemini.generate({ model: 'models/text-bison-001', prompt: likelihoodPrompt });
        const rawLikelihood = likelihoodResp.text.trim();
        const likelihood = parseInt(rawLikelihood.replace(/\D/g, ''), 10) || '';

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
        const stocksResp = await gemini.generate({ model: 'models/text-bison-001', prompt: stocksPrompt });
        let stocks = [];
        try {
          stocks = JSON.parse(stocksResp.text);
        } catch (parseErr) {
          console.error('Stock parse error:', parseErr);
        }

        // Write results back into sheet: column E (5) for likelihood, F (6) for stocks JSON
        const rowIndex = i + 1;
        const likelihoodCell = `E${rowIndex}`;
        const stocksCell = `F${rowIndex}`;
        sheet[likelihoodCell] = { t: 'n', v: likelihood };
        sheet[stocksCell] = { t: 's', v: JSON.stringify(stocks) };
      }

      // Generate updated workbook buffer
      const outBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

      // Return as downloadable Excel file
      res.setHeader('Content-Disposition', 'attachment; filename="results.xlsx"');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.send(outBuffer);
    } catch (error) {
      console.error('Processing error:', error);
      res.status(500).json({ error: error.message });
    } finally {
      // Cleanup uploaded file
      fs.unlink(file.filepath, () => {});
    }
  });
}
