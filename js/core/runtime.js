(function initCoreRuntime(global) {
  'use strict';

    const nowText = () => new Date().toLocaleString('zh-CN', { hour12: false });
    const uid = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const cleanName = (value) => String(value || '').replace(/\s+/g, '').trim();
    const safeFilePart = (str) => String(str || '').replace(/[\\/:*?"<>|]/g, '_');
    const loadStyleOnce = (id, href) => new Promise((resolve, reject) => {
      const existing = document.getElementById(id);
      if (existing) {
        resolve();
        return;
      }
      const link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      link.href = href;
      link.onload = resolve;
      link.onerror = reject;
      document.head.appendChild(link);
    });
    const loadScriptOnce = (id, src) => new Promise((resolve, reject) => {
      const existing = document.getElementById(id);
      if (existing) {
        if (existing.dataset.loaded === 'true') resolve();
        else existing.addEventListener('load', resolve, { once: true });
        return;
      }
      const script = document.createElement('script');
      script.id = id;
      script.src = src;
      script.async = true;
      script.onload = () => {
        script.dataset.loaded = 'true';
        resolve();
      };
      script.onerror = reject;
      document.body.appendChild(script);
    });
    const pad2 = (value) => String(value || '').padStart(2, '0');
    const excelSerialToDateText = (value) => {
      const serial = Number(value);
      if (!Number.isFinite(serial) || serial < 20000 || serial > 80000) return '';
      const date = new Date(Math.round((serial - 25569) * 86400 * 1000));
      return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
    };
    const normalizeDailyMonth = (value) => {
      if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}`;
      }
      if (typeof value === 'number') {
        return excelSerialToDateText(value).slice(0, 7);
      }
      const text = String(value || '').trim();
      if (!text) return '';
      if (/^\d{5}$/.test(text)) return excelSerialToDateText(Number(text)).slice(0, 7);
      const normalized = text.replace(/[./]/g, '-');
      let match = normalized.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?/);
      if (!match) match = text.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月/);
      return match ? `${match[1]}-${pad2(match[2])}` : '';
    };
    const normalizeDailyDate = (value, fallbackMonth = '') => {
      if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
      }
      if (typeof value === 'number') return excelSerialToDateText(value);
      const text = String(value || '').trim();
      if (!text) return '';
      if (/^\d{5}$/.test(text)) return excelSerialToDateText(Number(text));
      const normalized = text.replace(/[./]/g, '-');
      let match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (match) return `${match[1]}-${pad2(match[2])}-${pad2(match[3])}`;
      match = text.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
      if (match) return `${match[1]}-${pad2(match[2])}-${pad2(match[3])}`;
      match = text.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
      if (match && fallbackMonth) return `${fallbackMonth}-${pad2(match[2])}`;
      const month = normalizeDailyMonth(text);
      return month ? `${month}-01` : text;
    };
    const htmlToPlainText = (value) => {
      const text = String(value || '');
      if (!/<[a-z][\s\S]*>/i.test(text)) return text.trim();
      const container = document.createElement('div');
      container.innerHTML = text
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n');
      return (container.textContent || container.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    };
    const escapeHtml = (value) => String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
    const plainTextToHtml = (value) => escapeHtml(value).replace(/\r?\n/g, '<br>');
    const sanitizeRichHtml = (value) => {
      const source = String(value || '').trim();
      if (!source) return '';
      const allowedTags = new Set(['SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'BR', 'DIV', 'P', 'OL', 'UL', 'LI']);
      const template = document.createElement('template');
      template.innerHTML = source;
      const cleanNode = (node) => {
        if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent || '');
        if (node.nodeType !== Node.ELEMENT_NODE) return document.createTextNode('');
        const tag = node.tagName;
        if (!allowedTags.has(tag)) {
          const fragment = document.createDocumentFragment();
          Array.from(node.childNodes).forEach(child => fragment.appendChild(cleanNode(child)));
          return fragment;
        }
        const el = document.createElement(tag.toLowerCase());
        const style = node.getAttribute('style') || '';
        const safeStyle = [];
        const fontWeight = style.match(/font-weight\s*:\s*([^;]+)/i)?.[1];
        const fontStyle = style.match(/font-style\s*:\s*([^;]+)/i)?.[1];
        const textDecoration = style.match(/text-decoration\s*:\s*([^;]+)/i)?.[1];
        const fontSize = style.match(/font-size\s*:\s*([0-9.]+(?:px|pt|em|rem))/i)?.[1];
        const color = style.match(/color\s*:\s*(#[0-9a-fA-F]{3,8}|rgb\([^)]+\)|[a-zA-Z]+)\b/i)?.[1];
        if (fontWeight) safeStyle.push(`font-weight:${fontWeight}`);
        if (fontStyle) safeStyle.push(`font-style:${fontStyle}`);
        if (textDecoration) safeStyle.push(`text-decoration:${textDecoration}`);
        if (fontSize) safeStyle.push(`font-size:${fontSize}`);
        if (color) safeStyle.push(`color:${color}`);
        if (safeStyle.length) el.setAttribute('style', safeStyle.join(';'));
        Array.from(node.childNodes).forEach(child => el.appendChild(cleanNode(child)));
        return el;
      };
      const fragment = document.createDocumentFragment();
      Array.from(template.content.childNodes).forEach(child => fragment.appendChild(cleanNode(child)));
      const container = document.createElement('div');
      container.appendChild(fragment);
      return container.innerHTML;
    };
    const xmlFlagOn = (node, tagName) => {
      const child = node?.getElementsByTagName(tagName)?.[0];
      if (!child) return false;
      const val = child.getAttribute('val');
      return val === null || !['0', 'false', 'none'].includes(String(val).toLowerCase());
    };
    const richTextXmlToHtml = (xml) => {
      const source = String(xml || '').trim();
      if (!source) return '';
      try {
        const doc = new DOMParser().parseFromString(`<root>${source}</root>`, 'application/xml');
        if (doc.getElementsByTagName('parsererror').length) return '';
        const runs = Array.from(doc.getElementsByTagName('r'));
        const renderText = (text) => escapeHtml(text).replace(/\r?\n/g, '<br>');
        if (runs.length === 0) {
          const text = Array.from(doc.getElementsByTagName('t')).map(node => node.textContent || '').join('');
          return plainTextToHtml(text);
        }
        return sanitizeRichHtml(runs.map(run => {
          const rpr = run.getElementsByTagName('rPr')[0];
          const text = Array.from(run.getElementsByTagName('t')).map(node => node.textContent || '').join('');
          const styles = [];
          if (xmlFlagOn(rpr, 'b')) styles.push('font-weight:700');
          if (xmlFlagOn(rpr, 'i')) styles.push('font-style:italic');
          if (xmlFlagOn(rpr, 'u')) styles.push('text-decoration:underline');
          if (xmlFlagOn(rpr, 'strike')) styles.push('text-decoration:line-through');
          const size = rpr?.getElementsByTagName('sz')?.[0]?.getAttribute('val');
          if (size) styles.push(`font-size:${size}pt`);
          const color = rpr?.getElementsByTagName('color')?.[0]?.getAttribute('rgb');
          if (color && /^[0-9a-fA-F]{8}$/.test(color)) styles.push(`color:#${color.slice(2)}`);
          return `<span${styles.length ? ` style="${styles.join(';')}"` : ''}>${renderText(text)}</span>`;
        }).join(''));
      } catch (error) {
        return '';
      }
    };
    const cellToPlainText = (cell) => String(cell?.v ?? cell?.w ?? '').trim();
    const cellToRichHtml = (cell) => {
      const fromXml = richTextXmlToHtml(cell?.r || '');
      if (fromXml) return fromXml;
      return plainTextToHtml(cellToPlainText(cell));
    };
    const ELEMENT_PLUS_ZH_CN = {
      name: 'zh-cn',
      el: {
        datepicker: {
          now: '此刻',
          today: '今天',
          cancel: '取消',
          clear: '清空',
          confirm: '确定',
          selectDate: '选择日期',
          selectTime: '选择时间',
          startDate: '开始日期',
          startTime: '开始时间',
          endDate: '结束日期',
          endTime: '结束时间',
          prevYear: '上一年',
          nextYear: '下一年',
          prevMonth: '上个月',
          nextMonth: '下个月',
          year: '年',
          month1: '1月',
          month2: '2月',
          month3: '3月',
          month4: '4月',
          month5: '5月',
          month6: '6月',
          month7: '7月',
          month8: '8月',
          month9: '9月',
          month10: '10月',
          month11: '11月',
          month12: '12月',
          weeks: {
            sun: '日',
            mon: '一',
            tue: '二',
            wed: '三',
            thu: '四',
            fri: '五',
            sat: '六'
          },
          months: {
            jan: '一月',
            feb: '二月',
            mar: '三月',
            apr: '四月',
            may: '五月',
            jun: '六月',
            jul: '七月',
            aug: '八月',
            sep: '九月',
            oct: '十月',
            nov: '十一月',
            dec: '十二月'
          }
        },
        select: { loading: '加载中', noMatch: '无匹配数据', noData: '无数据', placeholder: '请选择' },
        messagebox: { title: '提示', confirm: '确定', cancel: '取消', error: '输入的数据不合法' }
      }
    };

    const normalizeItemKey = (value) => {
      let val = cleanName(value);
      // 只移除包含特定噪声词（如夏禾、厦禾、加收、组合、DR）的括号，保留有业务意义的括号内容（如器官、部位、性别）
      val = val.replace(/[（(][^）)]*(?:夏禾|厦禾|加收|组合|DR)[^）)]*[）)]/g, '');
      // 移除噪声词本身及末尾的检测/检查后缀
      val = val.replace(/夏禾|组合|加收/g, '').replace(/(?:检测|检查|测定)$/, '');
      // 移除所有非中文字符和非字母数字字符（忽略各种横线、空格、加号等标点符号差异）
      val = val.replace(/[^\w\u4e00-\u9fa5]/g, '');
      return val;
    };

  global.JKGLCore = Object.freeze({
    nowText,
    uid,
    cleanName,
    safeFilePart,
    loadStyleOnce,
    loadScriptOnce,
    normalizeDailyMonth,
    normalizeDailyDate,
    htmlToPlainText,
    sanitizeRichHtml,
    cellToPlainText,
    cellToRichHtml,
    ELEMENT_PLUS_ZH_CN,
    normalizeItemKey
  });
})(window);
