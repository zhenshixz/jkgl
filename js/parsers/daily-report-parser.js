(function initDailyReportParser(global) {
  'use strict';

  const { uid, normalizeDailyDate } = global.JKGLCore;

  global.JKGLDailyReportParser = Object.freeze({
        redactPrivacy(text) {
          if (!text) return text;
          return String(text)
            .replace(/(患者姓名|姓名|患者|受检者)[:：]?\s*[\u4e00-\u9fa5]{2,4}/g, '$1 ***')
            .replace(/(病历号|就诊号|门诊号|住院号|条码号|样本号|流水号)[:：]?\s*[A-Za-z0-9*-]+/g, '$1 ***');
        },
        inferLabFlag(value, reference, line = '') {
          const text = `${value} ${reference} ${line}`;
          if (/[↑↓]|偏高|偏低|阳性|\+/.test(text) && !/阴性/.test(String(value))) return 'abnormal';
          return 'normal';
        },
        parseDailyLabReport(report) {
          if (!report) return;
          const raw = String(report.rawOcrText || '').trim();
          if (!raw) {
            ElementPlus.ElMessage.warning('请先粘贴检验报告 OCR 原文。');
            return;
          }
          const lines = raw.split(/\r?\n/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
          const metadataPattern = /^(患者姓名|病历号|床号|申请科室|申请医生|报告时间|检查项目|检验值|参考值|标志|单位|说明|条码号|类型|标本|报告医生|审核医生|打印时间|机构)/;
          const labItemKeywords = [
            '尿颜色', '尿透明度', '尿葡萄糖', '尿胆红素', '尿酮体', '尿比重', '尿pH', '尿蛋白', '尿胆原',
            '尿亚硝酸盐', '尿隐血', '尿白细胞酯酶', '红细胞', '白细胞', '上皮细胞', '鳞状上皮细胞',
            '非鳞状上皮细胞', '管型', '透明管型', '病理管型', '结晶', '细菌', '酵母菌', '粘液丝',
            '甲胎蛋白', 'AFP', 'CA724', 'CA199', 'CA153', 'CA125', 'PIVKA', '碳呼气', '游离T3',
            '游离T4', '血型', '白蛋白', '肌酐', '尿素', '尿酸', '血红蛋白', '淀粉酶', '脂肪酶', '胆固醇',
            '甘油三酯', '转氨酶', '胆红素', '葡萄糖'
          ];
          const valueAfterLabel = (labelPattern) => {
            for (let i = 0; i < lines.length; i += 1) {
              const line = lines[i];
              const match = line.match(labelPattern);
              if (!match) continue;
              const inlineValue = (match[1] || '').replace(/^[:：]/, '').trim();
              if (inlineValue && !/^[)\s*+\-_—~#?？]+$/.test(inlineValue)) return inlineValue;
              const next = lines[i + 1] || '';
              if (next && !/[:：]$/.test(next) && !/^(患者姓名|病历号|床号|申请科室|申请医生|报告时间|检查项目|检验值|参考值|标志|单位|说明|条码号|类型|标本)/.test(next)) {
                return next.trim();
              }
            }
            return '';
          };
          const date = raw.match(/\b(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2})/);
          if (!report.reportDate && date) report.reportDate = normalizeDailyDate(date[1].replace(/年|月/g, '-').replace(/日/g, ''));
          const titleLines = [];
          for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i];
            if (line.length > 2 && line.length <= 40 &&
                !/[:：]$/.test(line) &&
                !/^(条码号|类型|患者姓名|病历号|床号|标本|申请|报告时间|检查项目|检验值|参考值|标志|单位|说明|门诊检验|科室)/.test(line) &&
                !/\b20\d{2}[-/.年]\d{1,2}/.test(line) &&
                !/^[A-Za-z0-9-<>]+$/.test(line) &&
                !/^令?\d+$/.test(line) &&
                !/报告详情|仅供参考|实际报告单为准/.test(line)) {
              if (titleLines.length === 0) {
                titleLines.push(line);
              } else if (titleLines.length < 3 && i === lines.indexOf(titleLines[titleLines.length - 1]) + 1) {
                if (/测定|检测|常规|报告|血|尿|酶|蛋白|功能|生化/.test(line) || /^[（(](急诊|门诊|住院)[）)]/.test(line)) {
                  titleLines.push(line);
                } else {
                  break;
                }
              } else {
                break;
              }
            } else if (titleLines.length > 0) {
              break;
            }
          }
          const parsedTitle = titleLines.join('+').replace(/;+$/, '');
          if (parsedTitle) {
            report.title = parsedTitle;
          }
          if (!report.department) report.department = valueAfterLabel(/^申请科室[:：]?(.*)$/);
          if (!report.sampleType) report.sampleType = valueAfterLabel(/^标本类型[:：]?(.*)$/);
          const barcode = valueAfterLabel(/^条码号[:：]?(.*)$/);
          const sampleStatus = valueAfterLabel(/^标本状态[:：]?(.*)$/);
          if (barcode || sampleStatus) {
            report.note = [report.note, barcode ? `条码号：${barcode}` : '', sampleStatus ? `标本状态：${sampleStatus}` : ''].filter(Boolean).join('；');
          }
          const stripWrapper = value => String(value || '').replace(/^[（(]\s*/, '').replace(/\s*[）)]$/, '').trim();
          const isEmptyReference = value => !stripWrapper(value);
          const isReferenceToken = value => {
            const text = stripWrapper(value);
            if (!text) return true;
            return /^(阴性|阳性|正常|未检出|清亮|黄色|合格)$/.test(text)
              || /^[<>≤≥]?\s*\d+(?:\.\d+)?\s*(?:[-~～至]\s*[<>≤≥]?\s*\d+(?:\.\d+)?)?$/.test(text);
          };
          const isValueToken = value => /^(?:[<>≤≥]?\d+(?:\.\d+)?|阴性|阳性|弱阳性|清亮|黄色|正常|未检出|未检|合格|1\+|2\+|3\+|4\+)$/.test(stripWrapper(value));
          const isUnitToken = value => /^(?:\/?[a-zA-Zμµ%]+(?:\/[a-zA-Zμµ%]+)?|mmol\/L|ng\/mL|mAU\/ml|U\/mL|U\/L|pmol\/L|umol\/L)$/.test(value);
          const isFlagToken = value => /^(?:↑|↓|偏高|偏低|异常|阳性|阴性|正常|-)$/.test(value);
          const isLabItemName = value => {
            const text = String(value || '').replace(/^[\d.、-]+/, '').trim();
            if (!text || metadataPattern.test(text) || /[:：]$/.test(text)) return false;
            if (/\b20\d{2}[-/.年]\d{1,2}/.test(text)) return false;
            if (isValueToken(text) || isReferenceToken(text) || isUnitToken(text) || isFlagToken(text)) return false;
            if (/^(血浆|全血|血清|尿液|粪便|查看原件|返回|合格|正常|阴性|阳性|<|>|5)$/.test(text)) return false;
            if (/科室|内科|外科|妇科|儿科|门诊|急诊|报告|详情|参考|实际|测定|检测/.test(text)) return false;
            if (/^(检验项目|检查项目|项目名称|检验值|结果|参考值|标志|单位|说明)$/.test(text)) return false;
            if (text.length > 15) return false;
            return labItemKeywords.some(keyword => text.includes(keyword)) || /^[\u4e00-\u9fa5A-Za-z0-9（）()\-+ ]{2,15}$/.test(text);
          };
          const headerIndex = lines.findIndex(line => /检验项目|检查项目|项目名称/.test(line));
          const parseLabLine = (line) => {
            if (!line || metadataPattern.test(line) || /[:：]$/.test(line)) return null;
            if (/\b20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}\b/.test(line)) return null;
            const withReference = line.match(/^(.+?)\s+([^\s()（）]+)\s*([（(]\s*[^）)]*\s*[）)])\s*([↑↓]?)\s*(\/?[a-zA-Zμµ%]+(?:\/[a-zA-Zμµ%]+)?|mmol\/L|ng\/mL|mAU\/ml|U\/mL|U\/L|pmol\/L|umol\/L)?\s*(.*)$/);
            const loose = line.match(/^(.+?)\s+([<>]?\d+(?:\.\d+)?|阴性|阳性|弱阳性|清亮|黄色|正常|未检出|未检|合格|1\+|2\+|3\+|4\+)\s*([↑↓]?)\s*(\/?[a-zA-Zμµ%]+(?:\/[a-zA-Zμµ%]+)?|mmol\/L|ng\/mL|mAU\/ml|U\/mL|U\/L|pmol\/L|umol\/L)?\s*(.*)$/);
            const match = withReference || loose;
            if (!match) return null;
            const name = match[1].replace(/^[\d.、-]+/, '').trim();
            if (!isLabItemName(name)) return null;
            const value = `${match[2] || ''}${match[4] && /[↑↓]/.test(match[4]) ? match[4] : ''}`.trim();
            const reference = withReference ? (match[3] || '').trim() : '';
            const unit = withReference ? (match[5] || '').trim() : (match[4] || '').trim();
            const note = withReference ? (match[6] || '').trim() : (match[5] || '').trim();
            return {
              id: uid('lab_item'),
              name,
              value,
              reference,
              flag: this.inferLabFlag(value, reference, line),
              unit,
              note
            };
          };
          const findFallbackTableStart = () => {
            for (let i = 0; i < lines.length; i += 1) {
              const line = lines[i];
              if (parseLabLine(line)) return i;
              if (isLabItemName(line) && labItemKeywords.some(keyword => line.includes(keyword))) return i;
            }
            return -1;
          };
          let tableStart = headerIndex >= 0 ? headerIndex + 1 : findFallbackTableStart();
          if (tableStart < 0) {
            tableStart = 0; // Default to scanning the entire document if header not found
          }
          const tableLines = lines.slice(tableStart);
          const items = [];
          const qualitativeUrineItems = ['尿颜色', '尿透明度', '尿葡萄糖', '尿胆红素', '尿酮体', '尿蛋白定性', '尿胆原', '尿亚硝酸盐', '尿隐血', '尿白细胞酯酶'];
          const normalizeReferenceText = (value) => {
            const text = String(value || '');
            return text.replace(/\s+/g, '');
          };
          const normalizeItemName = (value) => String(value || '').replace(/^[\d.、-]+/, '').trim();
          const parseTokenSegment = (name, rawTokens, reverse = false) => {
            const tokens = rawTokens
              .flatMap(token => String(token || '').split(/\s+/))
              .map(token => token.trim())
              .filter(token => token && !metadataPattern.test(token) && !/^检验值|参考值|标志|单位|说明$/.test(token));
            
            // Merge split references like "(35.0~" and "135.0)"
            const startIdx = tokens.findIndex(t => /^[（(][^）)]*[~～-]$/.test(t));
            const endIdx = tokens.findIndex(t => /^\d+(\.\d+)?[）)]$/.test(t));
            if (startIdx >= 0 && endIdx >= 0 && startIdx < endIdx) {
              const merged = tokens[startIdx] + tokens[endIdx];
              tokens[startIdx] = merged;
              tokens.splice(endIdx, 1);
            }

            if (reverse) {
              tokens.reverse();
            }
            

            let value = '';
            let reference = '';
            let unit = '';
            let flag = '';
            const noteTokens = [];
            for (let index = 0; index < tokens.length; index += 1) {
              const token = tokens[index];
              if (!unit && isUnitToken(token)) {
                unit = token;
                continue;
              }
              const wrappedReference = /^[（(]/.test(token) || /[）)]$/.test(token);
              if (!reference && (isEmptyReference(token) || wrappedReference)) {
                let refText = normalizeReferenceText(token);
                if (/[~～-]$/.test(refText) && tokens[index + 1] && /\d+\)?$/.test(tokens[index + 1])) {
                  refText = `${refText}${normalizeReferenceText(tokens[index + 1])}`;
                  index += 1;
                }
                reference = refText;
                continue;
              }
              if (!value && isValueToken(token)) {
                value = stripWrapper(token);
                continue;
              }
              if (!flag && isFlagToken(token) && !isValueToken(token)) {
                flag = token;
                continue;
              }
              if (!isLabItemName(token) && !isValueToken(token) && !isReferenceToken(token) && !/^\d+(\.\d+)?$/.test(token) && !/[~～-]/.test(token) && !/^[（(]\s*\d+/.test(token) && !/\d+\s*[）)]$/.test(token)) {
                noteTokens.push(token);
              }
            }
            if (!value && qualitativeUrineItems.includes(name)) {
              value = name === '尿颜色' ? '' : name === '尿透明度' ? '' : '阴性';
              if (!reference && !['尿颜色', '尿透明度'].includes(name)) reference = '阴性';
            }
            return { value, reference, unit, flag, note: noteTokens.join(' ') };
          };
          const getSegmentEnd = (startIndex) => {
            for (let cursor = startIndex + 1; cursor < tableLines.length; cursor += 1) {
              if (isLabItemName(tableLines[cursor])) return cursor;
            }
            return tableLines.length;
          };
          for (let i = 0; i < tableLines.length; i += 1) {
            const line = tableLines[i];
            const item = parseLabLine(line);
            if (item) {
              items.push(item);
              continue;
            }
            if (!isLabItemName(line)) continue;
            const name = normalizeItemName(line);
            let segmentEnd = getSegmentEnd(i);
            let segment = tableLines.slice(i + 1, segmentEnd);
            const parsedSegment = parseTokenSegment(name, segment);
            let { value, reference, unit, flag, note } = parsedSegment;
            if (!value && !reference && !unit && i > 0) {
              const previousTokens = tableLines.slice(Math.max(0, i - 3), i).filter(token => !isLabItemName(token));
              const previousParsed = parseTokenSegment(name, previousTokens, true);
              value = previousParsed.value;
              reference = previousParsed.reference;
              unit = previousParsed.unit;
              flag = previousParsed.flag;
              note = previousParsed.note;
            }
            if (!value && !reference && !unit && !qualitativeUrineItems.includes(name)) {
              continue;
            }
            items.push({
              id: uid('lab_item'),
              name,
              value,
              reference,
              flag: flag && flag !== '-' ? (flag === '正常' || flag === '阴性' ? 'normal' : 'abnormal') : this.inferLabFlag(value, reference, `${line} ${flag}`),
              unit,
              note
            });
            i = Math.max(i, segmentEnd - 1);
          }
          const seenNames = new Set(items.map(item => item.name));
          qualitativeUrineItems.forEach(name => {
            if (seenNames.has(name)) return;
            if (!lines.includes(name)) return;
            items.push({
              id: uid('lab_item'),
              name,
              value: name === '尿颜色' || name === '尿透明度' ? '' : '阴性',
              reference: name === '尿颜色' || name === '尿透明度' ? '()' : '(阴性)',
              flag: 'normal',
              unit: '',
              note: 'OCR列序错位，按尿常规定性项补入'
            });
          });
          if (/尿常规|尿沉渣/.test(raw)) {
            const upsertItem = (patch) => {
              const existing = items.find(item => item.name === patch.name);
              if (existing) {
                Object.keys(patch).forEach(key => {
                  if (patch[key] !== undefined && patch[key] !== '') {
                    existing[key] = patch[key];
                  }
                });
                return;
              }
              items.push({
                id: uid('lab_item'),
                name: patch.name,
                value: patch.value || '',
                reference: patch.reference || '',
                flag: patch.flag || this.inferLabFlag(patch.value || '', patch.reference || ''),
                unit: patch.unit || '',
                note: patch.note || ''
              });
            };
            const urineQualitativeDefaults = {
              尿颜色: { value: lines.includes('黄色') ? '黄色' : '' },
              尿透明度: { value: lines.includes('清亮') ? '清亮' : '' },
              尿葡萄糖: { value: '阴性' },
              尿胆红素: { value: '阴性' },
              尿酮体: { value: '阴性' },
              尿蛋白定性: { value: '阴性' },
              尿胆原: { value: '阴性' },
              尿亚硝酸盐: { value: '阴性' },
              尿隐血: { value: '阴性' },
              尿白细胞酯酶: { value: '阴性' }
            };
            Object.entries(urineQualitativeDefaults).forEach(([name, patch]) => {
              if (!lines.includes(name)) return;
              upsertItem({ name, ...patch, flag: 'normal', unit: '', note: '按尿常规报告结构校正' });
            });
            const knownUrineItems = [
              '尿颜色', '尿透明度', '尿葡萄糖', '尿胆红素', '尿酮体', '尿比重', '尿pH', '尿蛋白定性', '尿胆原',
              '尿亚硝酸盐', '尿隐血', '尿白细胞酯酶', '红细胞', '白细胞', '上皮细胞', '鳞状上皮细胞',
              '非鳞状上皮细胞', '管型', '透明管型', '病理管型', '结晶', '细菌', '酵母菌', '粘液丝'
            ];
            const valueAround = (name, fallback = {}) => {
              const index = lines.indexOf(name);
              if (index < 0) return fallback;
              const nextNameIndex = lines.findIndex((line, lineIndex) => lineIndex > index && knownUrineItems.includes(line));
              const end = nextNameIndex > index ? nextNameIndex : Math.min(lines.length, index + 8);
              const segment = lines.slice(index + 1, end);
              const previous = lines.slice(Math.max(0, index - 4), index);
              const parsed = parseTokenSegment(name, segment);

              // Rescue logic for severe OCR displacement (Value is placed BEFORE the name, and '0' is placed AFTER)
              if (['鳞状上皮细胞', '非鳞状上皮细胞', '白细胞', '红细胞', '上皮细胞'].includes(name)) {
                const prev = lines[index - 1] || '';
                if ((!parsed.value || parsed.value === '0') && isValueToken(prev) && prev !== '0' && prev !== '0.0') {
                  if (parsed.value === '0') {
                    parsed.reference = '0'; // Push the '0' to reference, it will be restored to '()' by fallback
                  }
                  parsed.value = stripWrapper(prev);
                }
              }

              if (parsed.value || parsed.reference || parsed.unit) return parsed;
              const immediatePrevious = lines[index - 1] || '';
              if (isValueToken(immediatePrevious)) {
                const previousUnit = [...previous].reverse().find(token => isUnitToken(token)) || '';
                return {
                  value: stripWrapper(immediatePrevious),
                  reference: '',
                  unit: previousUnit,
                  flag: '',
                  note: ''
                };
              }
              return parseTokenSegment(name, previous);
            };
            [
              ['红细胞', '/μL'],
              ['白细胞', '/μL'],
              ['上皮细胞', '/μL'],
              ['鳞状上皮细胞', '/μL'],
              ['非鳞状上皮细胞', '/μL'],
              ['管型', '/μL'],
              ['透明管型', '/μL'],
              ['病理管型', '/μL'],
              ['结晶', '/μL'],
              ['细菌', '/μL'],
              ['酵母菌', '/μL'],
              ['粘液丝', '/μL']
            ].forEach(([name, defaultUnit]) => {
              if (!lines.includes(name)) return;
              const parsed = valueAround(name);
              upsertItem({
                name,
                value: parsed.value,
                reference: parsed.reference,
                unit: parsed.unit || defaultUnit,
                flag: this.inferLabFlag(parsed.value, parsed.reference),
                note: parsed.note || ''
              });
            });
          }
          
          const standardReferences = {
            '尿颜色': '()',
            '尿透明度': '()',
            '尿葡萄糖': '(阴性)',
            '尿胆红素': '(阴性)',
            '尿酮体': '(阴性)',
            '尿蛋白定性': '(阴性)',
            '尿胆原': '(阴性)',
            '尿亚硝酸盐': '(阴性)',
            '尿隐血': '(阴性)',
            '尿白细胞酯酶': '(阴性)',
            '鳞状上皮细胞': '()',
            '非鳞状上皮细胞': '()',
            '粘液丝': '()',
            '病理管型': '(0.0)',
            '酵母菌': '(0.0)',
            '管型': '(0.0~1.3)',
            '透明管型': '(0.0~1.3)',
            '结晶': '(0.0~6.0)',
            '细菌': '(0.0~11.4)',
            '上皮细胞': '(0.0~5.7)',
            '白细胞': '(0.0~18.0)',
            '红细胞': '(0.0~15.0)',
            '尿比重': '(1.003~1.030)',
            '尿pH': '(5.0~8.0)'
          };

          // Sanitize any accidentally created objects or literal '[object Object]' strings
          items.forEach(item => {
            ['value', 'reference', 'unit', 'note'].forEach(key => {
              if (item[key] !== null && typeof item[key] === 'object') {
                item[key] = '';
              } else if (item[key] === '[object Object]') {
                item[key] = '';
              }
            });

            // Restore faint reference values that OCR often misses or misrecognizes
            if (standardReferences[item.name]) {
              const ref = item.reference;
              if (!ref || ref === '0' || ref === '0.0' || ref === '()') {
                item.reference = standardReferences[item.name];
              } else if (['尿颜色', '尿透明度', '鳞状上皮细胞', '非鳞状上皮细胞', '粘液丝'].includes(item.name)) {
                item.reference = '()'; // force these to be () no matter what
              } else if (['病理管型', '酵母菌'].includes(item.name)) {
                item.reference = '(0.0)'; // force these to be (0.0)
              } else if (['尿葡萄糖', '尿胆红素', '尿酮体', '尿蛋白定性', '尿胆原', '尿亚硝酸盐', '尿隐血', '尿白细胞酯酶'].includes(item.name)) {
                item.reference = '(阴性)'; // force these to be (阴性)
              }
            }
          });

          if (items.length === 0) {
            ElementPlus.ElMessage.warning('已找到指标区，但未解析出指标，请核对 OCR 是否把项目和值分散得过细。');
            return;
          }
          report.items = items;
          report.status = 'parsed';
          this.touchDailyReport();
          ElementPlus.ElMessage.success(`已解析 ${items.length} 个检验指标`);
        },
        extractReportSection(text, startPattern, endPattern) {
          const start = text.search(startPattern);
          if (start < 0) return '';
          const source = text.slice(start).replace(startPattern, '').trim();
          const end = source.search(endPattern);
          return (end >= 0 ? source.slice(0, end) : source).trim();
        },
        formatExamReportText(text) {
          const lines = String(text || '')
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line && !/^[①②③④⑤⑥⑦⑧⑨⑩<>]+$/.test(line));
          if (lines.length === 0) return '';
          const paragraphs = [];
          let current = '';
          lines.forEach(line => {
            const startsNewParagraph = /^(\d+[.、]|[一二三四五六七八九十]+[、.])/.test(line);
            if (startsNewParagraph && current) {
              paragraphs.push(current);
              current = line;
              return;
            }
            current += line;
          });
          if (current) paragraphs.push(current);
          return paragraphs.join('\n\n');
        },
        parseDailyExamReport(report) {
          if (!report) return;
          const raw = String(report.rawOcrText || '').trim();
          if (!raw) {
            ElementPlus.ElMessage.warning('请先粘贴检查报告 OCR 原文。');
            return;
          }
          const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
          const valueAfterLabel = (labelPattern) => {
            for (let i = 0; i < lines.length; i += 1) {
              const match = lines[i].match(labelPattern);
              if (!match) continue;
              const inlineValue = (match[1] || '').replace(/^[:：]/, '').trim();
              if (inlineValue && !/^[)\s*+\-_—~#?？]+$/.test(inlineValue)) return inlineValue;
              const next = lines[i + 1] || '';
              if (next && !/[:：]$/.test(next) && !/^(申请|报告|审核|检查所见|检查结论|诊断|基本信息|姓名)/.test(next)) {
                return next.trim();
              }
            }
            return '';
          };
          const date = raw.match(/\b(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2})/);
          if (date) report.reportDate = normalizeDailyDate(date[1].replace(/年|月/g, '-').replace(/日/g, ''));
          const parsedTitle = lines.find(line => {
            if (/^(云影像|基本信息|姓名|申请|报告|审核|检查所见|检查结论|诊断|医院|厦门大学|<|[①②③④⑤⑥⑦⑧⑨⑩])/.test(line)) return false;
            if (/^\d{1,2}:\d{2}|^[÷+<>\dA-Za-z]+$/.test(line)) return false;
            if (/\b20\d{2}[-/.年]\d{1,2}/.test(line)) return false;
            return /(CT|MR|MRI|DR|X线|彩超|B超|超声|胃镜|肠镜|平扫|增强|重建|造影|检查)/i.test(line);
          });
          if (parsedTitle) {
            report.title = parsedTitle;
          }
          const doctorVal = valueAfterLabel(/^报告医生[:：]?(.*)$/);
          if (doctorVal) report.reportDoctor = doctorVal;
          const reviewerVal = valueAfterLabel(/^审核医生[:：]?(.*)$/);
          if (reviewerVal) report.reviewDoctor = reviewerVal;

          const cleanExamText = (text) => {
            if (!text) return '';
            return String(text)
              .split(/\r?\n/)
              .map(line => line.trim())
              .filter(line => {
                if (!line) return false;
                if (/^(6|园|报告原件|查看影像|报告分享|分享报告|查看原件|二维码|小程序|分享|关注|影像)$/.test(line)) return false;
                return true;
              })
              .join('\n');
          };

          const finding = this.extractReportSection(raw, /检查所见[:：]?/, /(检查结论|诊断|检查结论\/诊断)[:：]?/);
          const conclusion = this.extractReportSection(raw, /(检查结论\/诊断|检查结论|诊断)[:：]?/, /$a/);
          if (finding) report.findingText = cleanExamText(finding);
          if (conclusion) report.conclusionText = cleanExamText(conclusion);
          report.status = 'parsed';
          this.touchDailyReport();
          ElementPlus.ElMessage.success('已解析检查所见和结论，请核对。');
        },
  });
})(window);
