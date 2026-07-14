const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const TYPES = {
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.mp3': 'audio/mpeg',
};

http.createServer((req, res) => {
  let file = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
  const full = path.join(__dirname, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));

  const ext = path.extname(full);

  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    // For the HTML page, rewrite the link-preview image to an ABSOLUTE URL
    // built from the request host, so iMessage/iOS reliably shows the thumbnail
    // no matter what domain this is deployed on.
    if (ext === '.html') {
      const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
      const host = req.headers.host || ('localhost:' + PORT);
      const base = proto + '://' + host + '/';
      let html = data.toString('utf8')
        .replace(/content="og\.png"/g, 'content="' + base + 'og.png"')
        .replace(/href="og\.png"/g, 'href="' + base + 'og.png"');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log('jack meme running on ' + PORT));
