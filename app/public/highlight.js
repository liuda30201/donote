/*
 * 极简语法高亮 + Markdown 渲染（零依赖，本地内置，不引用任何 CDN）
 *
 * 安全约定：
 *  - 所有输出都先对原文做 HTML 转义，任何原始字节都不会进入 innerHTML
 *  - Markdown 仅识别 http(s) 链接，不做原始 HTML 透传
 *
 * 暴露全局对象：window.WBHighlight
 */
(function (global) {
  'use strict';

  function escapeHTML(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));
  }

  // 规则里的分组必须全部是非捕获组 (?:...)，否则组号与规则序号会错位
  var RULES = {
    json: [
      { cls: 'key', re: '"(?:[^"\\\\]|\\\\.)*"(?=\\s*:)' },
      { cls: 'string', re: '"(?:[^"\\\\]|\\\\.)*"' },
      { cls: 'number', re: '-?\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b' },
      { cls: 'bool', re: '\\b(?:true|false|null)\\b' },
      { cls: 'punct', re: '[{}\\[\\],:]' }
    ],
    jsts: [
      { cls: 'comment', re: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/' },
      { cls: 'string', re: '"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`' },
      { cls: 'number', re: '\\b0[xX][0-9a-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b' },
      { cls: 'keyword', re: '\\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|default|break|continue|new|class|extends|super|this|typeof|instanceof|in|of|try|catch|finally|throw|async|await|yield|import|export|from|as|delete|void|static|get|set|true|false|null|undefined|interface|type|enum|implements|public|private|protected|readonly)\\b' },
      { cls: 'fn', re: '\\b[A-Za-z_$][\\w$]*(?=\\s*\\()' },
      { cls: 'punct', re: '[{}()\\[\\];,.:=+\\-*/%<>!&|?~^]+' }
    ],
    python: [
      { cls: 'comment', re: '#[^\\n]*' },
      { cls: 'string', re: '"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'' },
      { cls: 'number', re: '\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b' },
      { cls: 'keyword', re: '\\b(?:def|class|return|if|elif|else|for|while|break|continue|pass|import|from|as|try|except|finally|raise|with|lambda|yield|global|nonlocal|assert|del|in|is|not|and|or|None|True|False|async|await|self)\\b' },
      { cls: 'fn', re: '\\b[A-Za-z_]\\w*(?=\\s*\\()' },
      { cls: 'punct', re: '[{}()\\[\\];,.:=+\\-*/%<>!&|?~^@]+' }
    ],
    css: [
      { cls: 'comment', re: '\\/\\*[\\s\\S]*?\\*\\/' },
      { cls: 'string', re: '"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'' },
      { cls: 'keyword', re: '@[A-Za-z-]+' },
      { cls: 'number', re: '#[0-9a-fA-F]{3,8}\\b|-?\\b\\d+(?:\\.\\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr|pt)?\\b' },
      { cls: 'key', re: '[a-zA-Z-]+(?=\\s*:)' },
      { cls: 'punct', re: '[{}()\\[\\];:,>+~*=/]' }
    ],
    sql: [
      { cls: 'comment', re: '--[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/' },
      { cls: 'string', re: '\'(?:\'\'|[^\'])*\'' },
      { cls: 'keyword', re: '\\b(?:select|from|where|insert|into|values|update|set|delete|create|table|index|view|drop|alter|add|join|left|right|inner|outer|on|group|by|order|having|limit|offset|union|all|distinct|as|and|or|not|null|is|in|exists|between|like|count|sum|avg|min|max|primary|key|foreign|references|default|int|integer|varchar|text|timestamp|boolean|date|begin|commit|rollback|case|when|then|else|end)\\b' },
      { cls: 'number', re: '\\b\\d+(?:\\.\\d+)?\\b' },
      { cls: 'punct', re: '[(),;.*=<>+\\-/%|]' }
    ],
    shell: [
      { cls: 'comment', re: '#[^\\n]*' },
      { cls: 'string', re: '"(?:[^"\\\\]|\\\\.)*"|\'[^\']*\'' },
      { cls: 'keyword', re: '\\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|function|return|echo|export|local|readonly|cd|set|unset|source|exit|trap|shift|sudo|apt|yum|dnf|docker|git|npm|node|systemctl|curl|wget|grep|sed|awk|cat|ls|rm|cp|mv|mkdir|chmod|chown)\\b' },
      { cls: 'number', re: '\\b\\d+\\b' },
      { cls: 'punct', re: '[|&;<>(){}[\\]$=`\\\\]+' }
    ],
    yaml: [
      { cls: 'comment', re: '#[^\\n]*' },
      { cls: 'key', re: '^[ \\t-]*[A-Za-z0-9_.\\-]+(?=\\s*:)' },
      { cls: 'string', re: '"(?:[^"\\\\]|\\\\.)*"|\'[^\']*\'' },
      { cls: 'bool', re: '\\b(?:true|false|null|yes|no|on|off)\\b' },
      { cls: 'number', re: '-?\\b\\d+(?:\\.\\d+)?\\b' },
      { cls: 'punct', re: '[:\\-\\[\\]{},]' }
    ],
    ini: [
      { cls: 'comment', re: '[;#][^\\n]*' },
      { cls: 'key', re: '^\\s*\\[[^\\]\\n]*\\]' },
      { cls: 'keyword', re: '^\\s*[A-Za-z0-9_.\\-]+(?=\\s*=)' },
      { cls: 'string', re: '"(?:[^"\\\\]|\\\\.)*"' },
      { cls: 'number', re: '\\b\\d+\\b' },
      { cls: 'punct', re: '[=\\[\\]]' }
    ],
    plain: []
  };

  function tokenize(code, rules) {
    if (!rules || !rules.length) return escapeHTML(code);

    var master = new RegExp(rules.map(function (r) { return '(' + r.re + ')'; }).join('|'), 'gm');
    var out = '';
    var last = 0;
    var match;

    while ((match = master.exec(code)) !== null) {
      if (match[0].length === 0) {
        master.lastIndex += 1;
        continue;
      }
      if (match.index > last) out += escapeHTML(code.slice(last, match.index));

      var ruleIndex = -1;
      for (var i = 1; i < match.length; i += 1) {
        if (match[i] !== undefined) {
          ruleIndex = i - 1;
          break;
        }
      }
      var rule = rules[ruleIndex] || { cls: 'plain' };
      out += '<span class="tok-' + rule.cls + '">' + escapeHTML(match[0]) + '</span>';
      last = match.index + match[0].length;
    }

    out += escapeHTML(code.slice(last));
    return out;
  }

  function highlight(code, lang) {
    var rules = RULES[lang] || RULES.plain;
    return tokenize(String(code == null ? '' : code), rules);
  }

  function prettyJSON(text) {
    try {
      var parsed = JSON.parse(text);
      return { ok: true, text: JSON.stringify(parsed, null, 2) };
    } catch (error) {
      return { ok: false, text: String(text == null ? '' : text) };
    }
  }

  // ---- Markdown（受限渲染） -------------------------------------------------

  function renderInline(text) {
    var out = escapeHTML(text);
    // 行内代码优先，避免其中的 * 被当作强调
    out = out.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
    // 仅 http(s) 链接
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return out;
  }

  function renderMarkdown(text) {
    var lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    var html = [];
    var listBuffer = [];
    var inCode = false;
    var codeLang = '';
    var codeBuffer = [];

    function flushList() {
      if (!listBuffer.length) return;
      html.push('<ul class="md-ul">' + listBuffer.map(function (item) {
        return '<li>' + renderInline(item) + '</li>';
      }).join('') + '</ul>');
      listBuffer = [];
    }

    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];

      var fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
      if (fence) {
        if (inCode) {
          html.push('<pre class="md-pre"><code>' + highlight(codeBuffer.join('\n'), detectLangByToken(codeLang)) + '</code></pre>');
          inCode = false;
          codeBuffer = [];
          codeLang = '';
        } else {
          flushList();
          inCode = true;
          codeLang = fence[1] || '';
        }
        continue;
      }

      if (inCode) {
        codeBuffer.push(line);
        continue;
      }

      if (/^\s*$/.test(line)) { flushList(); continue; }

      if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
        flushList();
        html.push('<hr class="md-hr">');
        continue;
      }

      var heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flushList();
        var level = heading[1].length;
        html.push('<h' + level + ' class="md-h' + level + '">' + renderInline(heading[2]) + '</h' + level + '>');
        continue;
      }

      var quote = line.match(/^\s*>\s?(.*)$/);
      if (quote) {
        flushList();
        html.push('<blockquote class="md-quote">' + renderInline(quote[1]) + '</blockquote>');
        continue;
      }

      var listItem = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.*)$/);
      if (listItem) {
        listBuffer.push(listItem[1]);
        continue;
      }

      flushList();
      html.push('<p class="md-p">' + renderInline(line) + '</p>');
    }

    if (inCode && codeBuffer.length) {
      html.push('<pre class="md-pre"><code>' + highlight(codeBuffer.join('\n'), detectLangByToken(codeLang)) + '</code></pre>');
    }
    flushList();

    return html.join('');
  }

  // ---- 语言识别 -------------------------------------------------------------

  var EXT_LANG = {
    json: 'json', jsonl: 'json', ndjson: 'json', geojson: 'json', webmanifest: 'json',
    js: 'jsts', mjs: 'jsts', cjs: 'jsts', jsx: 'jsts', ts: 'jsts', tsx: 'jsts',
    py: 'python', pyw: 'python',
    css: 'css', scss: 'css', less: 'css',
    sql: 'sql',
    sh: 'shell', bash: 'shell', zsh: 'shell', env: 'shell', dockerfile: 'shell',
    yml: 'yaml', yaml: 'yaml',
    ini: 'ini', conf: 'ini', cfg: 'ini', properties: 'ini', toml: 'ini', editorconfig: 'ini', gitignore: 'ini',
    md: 'markdown', markdown: 'markdown'
  };

  var LANG_LABEL = {
    json: 'JSON', jsts: 'JavaScript', python: 'Python', css: 'CSS',
    sql: 'SQL', shell: 'Shell', yaml: 'YAML', ini: 'INI', markdown: 'Markdown', plain: '纯文本'
  };

  function detectLangByToken(token) {
    var key = String(token || '').toLowerCase().trim();
    if (!key) return 'plain';
    if (EXT_LANG[key]) return EXT_LANG[key];
    if (LANG_LABEL[key]) return key;
    return 'plain';
  }

  function detectLang(filename, mime) {
    var name = String(filename || '').toLowerCase();
    var dot = name.lastIndexOf('.');
    if (dot >= 0) {
      var ext = name.slice(dot + 1);
      if (EXT_LANG[ext]) return EXT_LANG[ext];
    }
    var lowerMime = String(mime || '').toLowerCase().split(';')[0].trim();
    if (lowerMime === 'application/json' || lowerMime === 'application/x-ndjson') return 'json';
    if (lowerMime === 'text/markdown') return 'markdown';
    if (lowerMime === 'application/yaml' || lowerMime === 'text/yaml') return 'yaml';
    return 'plain';
  }

  function langLabel(lang) {
    return LANG_LABEL[lang] || '纯文本';
  }

  global.WBHighlight = {
    escapeHTML: escapeHTML,
    highlight: highlight,
    prettyJSON: prettyJSON,
    renderMarkdown: renderMarkdown,
    detectLang: detectLang,
    langLabel: langLabel
  };
}(typeof window !== 'undefined' ? window : this));
