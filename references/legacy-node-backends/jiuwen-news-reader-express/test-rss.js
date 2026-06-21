import { XMLParser } from 'fast-xml-parser';

const url = 'https://rsshub.pseudoyu.com/zaobao/znews/china';

console.log('Testing RSS fetch...');

try {
  const response = await fetch(url, {
    headers: {
      'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  console.log('Response status:', response.status);

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const xml = await response.text();
  console.log('XML length:', xml.length);
  console.log('XML preview:', xml.substring(0, 500));

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    processEntities: false,
    htmlEntities: false,
  });

  const result = parser.parse(xml);
  console.log('Parsed result keys:', Object.keys(result));

  const channel = result.rss?.channel || result.feed;
  console.log('Channel keys:', Object.keys(channel || {}));

  const items = channel?.item || channel?.entry || [];
  console.log('Items count:', Array.isArray(items) ? items.length : 1);

} catch (error) {
  console.error('Error:', error.message);
}

console.log('Test complete');
