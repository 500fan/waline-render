const fs = require('fs');
const path = require('path');

// Patch github.js to handle missing content and default GITHUB_PATH
const githubPath = path.join(__dirname, 'node_modules/@waline/vercel/src/service/storage/github.js');

if (fs.existsSync(githubPath)) {
  let code = fs.readFileSync(githubPath, 'utf-8');

  if (code.includes("Buffer.from(resp.content, 'base64')")) {
    code = code.replace(
      "Buffer.from(resp.content, 'base64').toString('utf-8')",
      "(resp.content ? Buffer.from(resp.content, 'base64').toString('utf-8') : '')"
    );
    console.log('[patch] Fixed Buffer.from(undefined) in github.js');
  }

  if (code.includes('this.basePath = GITHUB_PATH;')) {
    code = code.replace(
      'this.basePath = GITHUB_PATH;',
      'this.basePath = GITHUB_PATH || \'\';'
    );
    console.log('[patch] Added default GITHUB_PATH in github.js');
  }

  fs.writeFileSync(githubPath, code);
  console.log('[patch] github.js patched successfully');
}

// Remove old upload controller if exists
const controllerDir = path.join(__dirname, 'node_modules/@waline/vercel/src/controller');
const oldController = path.join(controllerDir, 'upload.js');
if (fs.existsSync(oldController)) {
  fs.unlinkSync(oldController);
  console.log('[patch] Removed old upload controller');
}

// Create upload middleware
const middlewareDir = path.join(__dirname, 'node_modules/@waline/vercel/src/middleware');
const uploadMiddlewarePath = path.join(middlewareDir, 'upload.js');

const uploadMiddlewareCode = `
const fs = require('fs');
const path = require('path');

async function ghFetch(token, url, opts = {}) {
  const resp = await fetch(url, {
    ...opts,
    headers: {
      accept: 'application/vnd.github.v3+json',
      authorization: \`token \${token}\`,
      'user-agent': 'Waline',
      ...(opts.headers || {}),
    },
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json.message || \`GitHub API \${resp.status}\`);
  return json;
}

module.exports = () => async (ctx, next) => {
  console.log('[upload-middleware]', ctx.method, ctx.path);
  if (ctx.path !== '/api/upload') return next();

  ctx.set('Access-Control-Allow-Origin', '*');
  ctx.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  ctx.set('Access-Control-Allow-Headers', 'Content-Type');

  if (ctx.method === 'OPTIONS') {
    ctx.status = 204;
    return;
  }

  const { GITHUB_TOKEN, GITHUB_REPO } = process.env;

  if (ctx.method === 'GET') {
    const id = ctx.query.id;
    if (!id) {
      ctx.type = 'application/json';
      ctx.body = JSON.stringify({ errno: 1, errmsg: 'Missing id' });
      return;
    }
    try {
      const json = await ghFetch(GITHUB_TOKEN, \`https://api.github.com/repos/\${GITHUB_REPO}/contents/images.json\`);
      const content = Buffer.from(json.content, 'base64').toString('utf-8');
      const images = JSON.parse(content);
      const img = images[id];
      if (!img) {
        ctx.type = 'application/json';
        ctx.body = JSON.stringify({ errno: 1, errmsg: 'Not found' });
        return;
      }
      ctx.type = img.type || 'image/png';
      ctx.body = Buffer.from(img.base64, 'base64');
    } catch (err) {
      ctx.type = 'application/json';
      ctx.body = JSON.stringify({ errno: 1, errmsg: err.message });
    }
    return;
  }

  if (ctx.method === 'POST') {
    if (!GITHUB_TOKEN || !GITHUB_REPO) {
      ctx.type = 'application/json';
      ctx.body = JSON.stringify({ errno: 1, errmsg: 'Not configured' });
      return;
    }

    const files = ctx.request.files;
    const body = ctx.request.body;
    let file = (files && (files.file || files.upload || (Array.isArray(files) ? files[0] : Object.values(files)[0])))
      || (body && body.file);
    // Handle nested structure: body.file.file
    if (file && file.file) file = file.file;
    if (!file) {
      ctx.type = 'application/json';
      ctx.body = JSON.stringify({ errno: 1, errmsg: 'No file' });
      return;
    }

    try {
      const filePath = file.filepath || file.path || file.filePath;
      const content = fs.readFileSync(filePath);
      const ext = path.extname(file.originalFilename || file.newFilename || file.name || '.png').toLowerCase();
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
      const type = mimeMap[ext] || 'image/png';

      let images = {};
      let sha = null;
      try {
        const json = await ghFetch(GITHUB_TOKEN, \`https://api.github.com/repos/\${GITHUB_REPO}/contents/images.json\`);
        images = JSON.parse(Buffer.from(json.content, 'base64').toString('utf-8'));
        sha = json.sha;
      } catch (err) {
        if (!err.message.includes('Not Found')) throw err;
      }

      images[id] = {
        name: file.originalFilename || file.newFilename || file.name || 'image' + ext,
        type,
        base64: content.toString('base64'),
        time: new Date().toISOString(),
      };

      const writeBody = {
        message: 'feat(waline): update images',
        content: Buffer.from(JSON.stringify(images, null, 2), 'utf-8').toString('base64'),
      };
      if (sha) writeBody.sha = sha;

      await ghFetch(GITHUB_TOKEN, \`https://api.github.com/repos/\${GITHUB_REPO}/contents/images.json\`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(writeBody),
      });

      ctx.type = 'application/json';
      ctx.body = JSON.stringify({
        errno: 0,
        data: {
          url: \`https://\${ctx.host}/api/upload?id=\${id}\`,
          alt: file.originalFilename || file.newFilename || file.name || 'image',
        },
      });
    } catch (err) {
      ctx.type = 'application/json';
      ctx.body = JSON.stringify({ errno: 1, errmsg: err.message });
    }
    return;
  }

  return next();
};
`;

fs.writeFileSync(uploadMiddlewarePath, uploadMiddlewareCode);
console.log('[patch] Created upload middleware');

// Patch comment controller to catch post-save errors
const commentCtrlPath = path.join(__dirname, 'node_modules/@waline/vercel/src/controller/comment.js');
let commentCode = fs.readFileSync(commentCtrlPath, 'utf-8');

// Simple patch: wrap the webhook + formatCmt + notify + postSave section
const oldPostSave = `    await this.ctx.webhook('new_comment', {
      comment: { ...resp, rawComment: comment },
      reply: parentComment,
    });

    const cmtReturn = await formatCmt(
      resp,
      [userInfo],
      { ...this.config(), deprecated: this.ctx.state.deprecated },
      userInfo,
    );
    const parentReturn = parentComment
      ? await formatCmt(
          parentComment,
          parentUser ? [parentUser] : [],
          { ...this.config(), deprecated: this.ctx.state.deprecated },
          userInfo,
        )
      : undefined;

    if (comment.status !== 'spam') {
      const notify = this.service('notify', this);

      await notify.run(
        { ...cmtReturn, mail: resp.mail, rawComment: comment },
        parentReturn ? { ...parentReturn, mail: parentComment.mail } : undefined,
      );
    }

    think.logger.debug(\`Comment notify done!\`);

    await this.hook('postSave', resp, parentComment);

    think.logger.debug(\`Comment post hooks postSave done!\`);

    return this.success(
      await formatCmt(
        resp,
        [userInfo],
        { ...this.config(), deprecated: this.ctx.state.deprecated },
        userInfo,
      ),
    );`;

const newPostSave = `    // [PATCHED] Wrap post-save in try-catch to prevent 502
    try {
      await this.ctx.webhook('new_comment', {
        comment: { ...resp, rawComment: comment },
        reply: parentComment,
      });

      const cmtReturn = await formatCmt(
        resp,
        [userInfo],
        { ...this.config(), deprecated: this.ctx.state.deprecated },
        userInfo,
      );
      const parentReturn = parentComment
        ? await formatCmt(
            parentComment,
            parentUser ? [parentUser] : [],
            { ...this.config(), deprecated: this.ctx.state.deprecated },
            userInfo,
          )
        : undefined;

      if (comment.status !== 'spam') {
        const notify = this.service('notify', this);

        await notify.run(
          { ...cmtReturn, mail: resp.mail, rawComment: comment },
          parentReturn ? { ...parentReturn, mail: parentComment.mail } : undefined,
        );
      }

      think.logger.debug(\`Comment notify done!\`);

      await this.hook('postSave', resp, parentComment);

      think.logger.debug(\`Comment post hooks postSave done!\`);
    } catch (postSaveErr) {
      console.error('[PATCHED] Post-save error (comment saved OK):', postSaveErr.message);
    }

    return this.success(
      await formatCmt(
        resp,
        [userInfo],
        { ...this.config(), deprecated: this.ctx.state.deprecated },
        userInfo,
      ).catch(() => resp),
    );`;

if (commentCode.includes("await this.ctx.webhook('new_comment',") && !commentCode.includes('[PATCHED]')) {
  commentCode = commentCode.replace(oldPostSave, newPostSave);
  fs.writeFileSync(commentCtrlPath, commentCode);
  console.log('[patch] Patched comment controller with post-save error handling');
}

// Register upload middleware in middleware config
const middlewareConfigPath = path.join(__dirname, 'node_modules/@waline/vercel/src/config/middleware.js');
let middlewareCode = fs.readFileSync(middlewareConfigPath, 'utf-8');

// Add upload middleware AFTER payload
if (!middlewareCode.includes("'upload'")) {
  const uploadMiddlewareEntry = `
  {
    handle: 'upload',
  },`;
  // Insert after payload block (after the limit: '5mb' line)
  middlewareCode = middlewareCode.replace(
    "limit: '5mb',\n    },\n  },",
    "limit: '5mb',\n    },\n  },\n" + uploadMiddlewareEntry
  );
  fs.writeFileSync(middlewareConfigPath, middlewareCode);
  console.log('[patch] Registered upload middleware after payload');
}
