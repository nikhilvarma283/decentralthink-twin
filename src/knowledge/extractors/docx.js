import mammoth from 'mammoth';

export async function extractDocx(source) {
  const buffer = source.buffer;
  if (!buffer) throw new Error('DOCX extraction requires a file buffer');

  const result = await mammoth.extractRawText({ buffer });
  return {
    text: result.value.trim(),
    metadata: {
      filename: source.filename,
      format: 'docx',
      warnings: result.messages?.length || 0,
    },
    contentType: 'docx',
  };
}
