console.log('Testing fetch...');

const url = 'https://rsshub.pseudoyu.com/zaobao/znews/china';

const startTime = Date.now();

fetch(url, {
  headers: {
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  },
})
  .then(response => {
    const elapsed = Date.now() - startTime;
    console.log(`Response received in ${elapsed}ms`);
    console.log('Status:', response.status);
    return response.text();
  })
  .then(text => {
    console.log('Text length:', text.length);
    console.log('Success!');
    process.exit(0);
  })
  .catch(error => {
    console.error('Error:', error.message);
    process.exit(1);
  });

// 超时处理
setTimeout(() => {
  console.error('Timeout after 30s');
  process.exit(1);
}, 30000);
