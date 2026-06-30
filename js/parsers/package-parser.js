(function initPackageParser(global) {
  'use strict';

  const createPackageParser = ({ uid, cleanName }) => {
    const parsePrice = (text) => {
      const source = String(text || '').replace(/,/g, '').trim();
      
      // 1. First try currency prefix search (avoid matching letters in words like FT3)
      const currencyMatch = source.match(/(?:^|[^a-zA-Z0-9])[￥¥YyVvFfTt*xX]\s*(\d{1,5}(?:\.\d{1,2})?)/);
      if (currencyMatch) return Number(currencyMatch[1]);
      
      // 2. If it's a clean standalone price line, match it exactly
      const cleanSource = source.replace(/[.\-_ /]+$/, '');
      const exactMatch = cleanSource.match(/^(\d{1,5}(?:\.\d{1,2})?)\s*(?:元)?$/);
      if (exactMatch) return Number(exactMatch[1]);
      
      // 3. Fallback for larger block (e.g. package parsing near string)
      const numbers = Array.from(source.matchAll(/(?:^|[^\d])(\d{2,5})(?:元)?(?:$|[^\d])/g))
        .map((match) => Number(match[1]))
        .filter((value) => value >= 20 && value <= 50000);
      return numbers.length ? numbers[numbers.length - 1] : 0;
    };

    const preprocessImageForOcr = (file) => new Promise((resolve) => {
      const image = new Image();
      const url = URL.createObjectURL(file);
      image.onload = () => {
        const scale = Math.min(2.4, Math.max(1.6, 1800 / image.width));
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
          const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
          const boosted = gray < 185 ? Math.max(0, gray - 35) : Math.min(255, gray + 20);
          const value = boosted < 205 ? 0 : 255;
          data[i] = value;
          data[i + 1] = value;
          data[i + 2] = value;
          data[i + 3] = 255;
        }
        ctx.putImageData(imageData, 0, 0);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);
          resolve(blob || file);
        }, 'image/png');
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(file);
      };
      image.src = url;
    });

    const likelyCategory = (line) => {
      const categories = ['放射科', '彩超室', '检验科', '内科', '外科', '眼科', '耳鼻喉科', '口腔科', '妇科', '男科', '心电图室', '功能科', '一般检查'];
      return categories.find((item) => line.includes(item)) || '';
    };

    const isNoiseLine = (line) => /健康体检|套餐信息|检查项目详情|检查内容详情|返回|立即预约|修改|recognizing|微信|5G|^\d{1,2}:\d{2}/i.test(line);

    const parseDetailItems = (rawText) => {
      const rawLines = rawText.split(/\n+/);
      const items = [];
      let category = '';

      // 1. Check if the text contains tab separators (Excel/Table paste)
      const hasTabs = rawLines.some(line => line.includes('\t'));
      if (hasTabs) {
        rawLines.forEach(line => {
          if (isNoiseLine(line)) return;
          const cols = line.split('\t').map(c => c.trim()).filter(c => c);
          if (cols.length < 2) return;

          let itemCat = '';
          let itemName = '';
          let itemPrice = 0;
          let itemNote = '';

          cols.forEach(col => {
            const cat = likelyCategory(col);
            if (cat && col.length <= 8) {
              itemCat = cat;
            } else if (/^[￥¥]?\s*\d+(\.\d+)?$/.test(col)) {
              itemPrice = parseFloat(col.replace(/[￥¥\s]/g, ''));
            } else if (/筛查|评估|诊断|疾病|功能|风险/.test(col) || col.length > 15) {
              itemNote = col;
            } else {
              if (!itemName) {
                itemName = col.replace(/^[<>、.\s\-+]+/, '').trim();
              } else if (col.length > 1 && !/^(已选|未选|选择|包含|原价|现价|自选|备注|操作)$/i.test(col)) {
                itemName = itemName + '(' + col + ')';
              }
            }
          });

          if (itemName && itemName.length >= 2 && !/^(科室|项目|内容|价格|金额|单价|备注)$/.test(itemName)) {
            items.push({
              id: uid('item'),
              category: itemCat || '未分类',
              name: itemName,
              price: itemPrice,
              note: itemNote,
              source: '文本导入',
              reviewStatus: 'pending'
            });
          }
        });

        if (items.length > 0) return items;
      }

      // 2. Regular line-by-line OCR parser
      const lines = rawLines
        .map((line) => line.replace(/[|｜]/g, '').replace(/\s+/g, ' ').trim())
        .filter((line) => line && !isNoiseLine(line));
      const isPriceText = (value) => /(?:^|[^a-zA-Z0-9])[￥¥YyVvFfTt*xX]\s*\d+(?:\.\d{1,2})?/.test(value) ||
                            /^\d{1,5}(?:\.\d{1,2})?\s*(?:元)?$/.test(value.replace(/[.\-_ /]+$/, ''));
      const looksLikeNote = (value) => /筛查|评估|诊断|疾病|功能|风险|了解|标志物|耗材费/.test(value);
      const looksLikeNameSuffix = (value) => {
        const text = cleanName(value);
        return text.length <= 16 && (/^[（(]/.test(text) || /[）)]$/.test(text) || /发光法|化学/.test(text));
      };

      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const cat = likelyCategory(line);
        if (cat && line.length <= 12) {
          category = cat;
          continue;
        }
        const isPriceLine = isPriceText(line);
        if (!isPriceLine) continue;

        const price = parsePrice(line);
        const sameLineName = line.replace(/[￥¥Yy]\s*\d+|^\d{1,4}$/g, '').trim();
        const nameParts = [];
        let note = '';
        if (sameLineName) {
          nameParts.push(sameLineName);
        } else {
          for (let j = i - 1; j >= 0 && nameParts.length < 4; j -= 1) {
            const candidate = lines[j];
            if (!candidate || isPriceText(candidate)) break;
            const candidateCat = likelyCategory(candidate);
            if (candidateCat && candidate.length <= 12) break;
            if (looksLikeNote(candidate) && !looksLikeNameSuffix(candidate)) {
              if (!note) note = candidate;
              if (nameParts.length && !nameParts.every(looksLikeNameSuffix)) break;
              continue;
            }
            nameParts.unshift(candidate);
          }
        }

        let name = nameParts.join('').replace(/[￥¥Yy]\s*\d+|^\d{1,4}$/g, '').trim();
        if (/套餐信息|检查项目详情|检查内容详情|返回|修改|立即预约/.test(name)) continue;
        if (likelyCategory(name) && lines[i - 2]) name = lines[i - 2];

        const next = lines[i + 1] || '';
        if (!note && looksLikeNote(next)) note = next;
        items.push({
          id: uid('item'),
          category: category || '未分类',
          name,
          price,
          note,
          source: 'OCR截图',
          reviewStatus: 'pending'
        });
      }
      return items;
    };

    const looksLikeDetailText = (rawText) => {
      const text = cleanName(rawText);
      return /检查项目详情|检查内容详情|项目名称|内容名称|检查意义|检验科|放射科|彩超室/.test(text)
        && /[￥¥]\d+|\n\d{1,5}\n/.test(rawText);
    };

    return {
      parsePrice,
      preprocessImageForOcr,
      parseDetailItems,
      looksLikeDetailText
    };
  };

  global.JKGLPackageParser = Object.freeze({ createPackageParser });
})(window);
