const fs = require('fs');
const path = require('path');
const BaseRest = require('./rest.js');

const GITHUB_API = 'https://api.github.com';

async function ghFetch(token, url, opts = {}) {
  const resp = await fetch(url, {
    ...opts,
    headers: {
      accept: 'application/vnd.github.v3+json',
      authorization: `token ${token}`,
      'user-agent': 'Waline',
      ...(opts.headers || {}),
    },
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json.message || `GitHub API ${resp.status}`);
  return json;
}

async function readImages(token, repo) {
  try {
    const json = await ghFetch(token, `${GITHUB_API}/repos/${repo}/contents/images.json`);
    const content = Buffer.from(json.content, 'base64').toString('utf-8');
    return { data: JSON.parse(content), sha: json.sha };
  } catch (err) {
    if (err.message && err.message.includes('Not Found')) return { data: {}, sha: null };
    throw err;
  }
}

async function writeImages(token, repo, data, sha) {
  const body = {
    message: 'feat(waline): update images',
    content: Buffer.from(JSON.stringify(data, null, 2), 'utf-8').toString('base64'),
  };
  if (sha) body.sha = sha;
  return ghFetch(token, `${GITHUB_API}/repos/${repo}/contents/images.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

module.exports = class extends BaseRest {
  constructor(ctx) {
    super(ctx);
  }

  async indexAction() {
    const { GITHUB_TOKEN, GITHUB_REPO } = process.env;

    // GET: serve image
    if (this.ctx.method === 'GET') {
      const id = this.get('id');
      if (!id) return this.json({ errno: 1, errmsg: 'Missing id' });
      try {
        const { data } = await readImages(GITHUB_TOKEN, GITHUB_REPO);
        const img = data[id];
        if (!img) return this.json({ errno: 1, errmsg: 'Not found' });
        this.ctx.type = img.type || 'image/png';
        this.ctx.body = Buffer.from(img.base64, 'base64');
      } catch (err) {
        return this.json({ errno: 1, errmsg: err.message });
      }
      return;
    }

    // POST: upload image
    if (!GITHUB_TOKEN || !GITHUB_REPO) {
      return this.json({ errno: 1, errmsg: 'Not configured' });
    }

    const file = this.file('file');
    if (!file) return this.json({ errno: 1, errmsg: 'No file' });

    try {
      const content = fs.readFileSync(file.path);
      const ext = path.extname(file.originalFilename || file.name || '.png').toLowerCase();
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
      const type = mimeMap[ext] || 'image/png';

      const { data: images, sha } = await readImages(GITHUB_TOKEN, GITHUB_REPO);
      images[id] = {
        name: file.originalFilename || file.name || 'image' + ext,
        type,
        base64: content.toString('base64'),
        time: new Date().toISOString(),
      };
      await writeImages(GITHUB_TOKEN, GITHUB_REPO, images, sha);

      return this.json({
        errno: 0,
        data: {
          url: `https://${this.ctx.host}/api/upload?id=${id}`,
          alt: file.originalFilename || file.name || 'image',
        },
      });
    } catch (err) {
      return this.json({ errno: 1, errmsg: err.message });
    }
  }
};
