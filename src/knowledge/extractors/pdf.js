import pdfParse from 'pdf-parse/lib/pdf-parse.js';

export async function extractPdf(source) {
  const buffer = source.buffer;
  if (!buffer) throw new Error('PDF extraction requires a file buffer');

  const data = await pdfParse(buffer);
  return {
    text: data.text.trim(),
    metadata: {
      filename: source.filename,
      format: 'pdf',
      pages: data.numpages,
      info: data.info,
    },
    contentType: 'pdf',
  };
}
