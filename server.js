const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const TYPES = {
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
};

http.createServer((req, res) => {
  let file = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
  const full = path.join(__dirname, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));

  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log('jack meme running on ' + PORT));
