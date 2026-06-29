// Run patch.js first
require('./patch.js');

const fs = require('fs');
const path = require('path');

// ========== Patch 1: Replace comment controller with simplified version ==========
function patchComment() {
  const commentPath = path.join(__dirname, 'node_modules/@waline/vercel/src/controller/comment.js');

  const simplifiedController = `const BaseRest = require('./rest.js');
const { getMarkdownParser } = require('../service/markdown/index.js');

const markdownParser = getMarkdownParser();

module.exports = class extends BaseRest {
  constructor(ctx) {
    super(ctx);
    this.modelInstance = this.getModel('Comment');
  }

  async getAction() {
    const { path: url, page, pageSize, sortBy } = this.get();
    const where = { url };
    const count = await this.modelInstance.count(where);
    const totalPages = Math.ceil(count / pageSize);
    const spamCount = await this.modelInstance.count({ ...where, status: 'spam' });
    const waitingCount = await this.modelInstance.count({ ...where, status: 'waiting' });
    const comments = await this.modelInstance.select(where, {
      desc: sortBy === 'time' ? 'insertedAt' : 'like',
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    return this.json({
      errno: 0,
      errmsg: '',
      data: {
        page,
        totalPages,
        pageSize,
        count: count - spamCount - waitingCount,
        data: comments.map(c => {
          c.comment = markdownParser(c.comment);
          c.time = new Date(c.insertedAt).getTime();
          delete c.insertedAt;
          delete c.createdAt;
          delete c.updatedAt;
          c.like = Number(c.like) || 0;
          c.children = [];
          return c;
        }),
      },
    });
  }

  async postAction() {
    const { comment, link, mail, nick, pid, rid, ua, url } = this.post();
    const data = {
      link, mail, nick, pid, rid, ua, url, comment,
      ip: this.ctx.ip,
      insertedAt: new Date(),
      user_id: '',
      status: 'approved',
    };

    const { userInfo } = this.ctx.state;
    if (userInfo && userInfo.objectId) {
      data.user_id = userInfo.objectId;
    }

    try {
      const resp = await this.modelInstance.add(data);
      return this.json({ errno: 0, errmsg: '', data: resp });
    } catch (err) {
      console.error('[SIMPLE_POST] Error:', err.message);
      return this.json({ errno: 1, errmsg: err.message });
    }
  }

  async deleteAction() {
    const { userInfo } = this.ctx.state;
    if (!userInfo || userInfo.type !== 'administrator') {
      return this.fail(403);
    }
    await this.modelInstance.delete({ objectId: this.id });
    return this.success();
  }

  async putAction() {
    const { userInfo } = this.ctx.state;
    if (!userInfo || userInfo.type !== 'administrator') {
      return this.fail(403);
    }
    const data = this.post();
    await this.modelInstance.update(data, { objectId: this.id });
    return this.success();
  }
};
`;

  fs.writeFileSync(commentPath, simplifiedController);
  console.log('[start.js] Replaced comment controller with simplified version (with markdown)');
}

// ========== Patch 2: Use Cloudinary direct upload for images ==========
function patchIndexForCloudinary() {
  const indexPath = path.join(__dirname, 'node_modules/@waline/vercel/src/controller/index.js');
  let code = fs.readFileSync(indexPath, 'utf-8');

  // Check if already patched
  if (code.includes('cloudinary')) {
    console.log('[start.js] index.js already patched for Cloudinary');
    return;
  }

  const CLOUD_NAME = 'dwevyln8l';
  const UPLOAD_PRESET = 'waline_unsigned';

  const oldInit = `serverURL: location.protocol + '//' + location.host + location.pathname.replace(/\\\\/+$/, ''),
          recaptchaV3Key: '\${process.env.RECAPTCHA_V3_KEY || ''}',
          turnstileKey: '\${process.env.TURNSTILE_KEY || ''}',`;

  const newInit = `serverURL: location.protocol + '//' + location.host + location.pathname.replace(/\\\\/+$/, ''),
          recaptchaV3Key: '\${process.env.RECAPTCHA_V3_KEY || ''}',
          turnstileKey: '\${process.env.TURNSTILE_KEY || ''}',
          imageUploader: async (file) => {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('upload_preset', '${UPLOAD_PRESET}');
            const resp = await fetch('https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload', {
              method: 'POST',
              body: formData,
            });
            const result = await resp.json();
            if (result.error) throw new Error(result.error.message);
            return result.secure_url;
          },`;

  if (code.includes(oldInit)) {
    code = code.replace(oldInit, newInit);
    fs.writeFileSync(indexPath, code);
    console.log('[start.js] Patched index.js with Cloudinary direct upload');
  } else {
    console.log('[start.js] Could not find init block in index.js to patch');
  }
}

// Run patches
try { patchComment(); } catch (err) { console.error('[start.js] patchComment error:', err.message); }
try { patchIndexForCloudinary(); } catch (err) { console.error('[start.js] patchIndexForCloudinary error:', err.message); }

// Load waline
require('@waline/vercel/vanilla.js');
