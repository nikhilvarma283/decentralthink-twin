export async function extractText(source) {
  const text = source.buffer?.toString('utf-8') || source.rawText || '';
  return {
    text: text.trim(),
    metadata: { filename: source.filename, format: 'text' },
    contentType: 'text',
  };
}
