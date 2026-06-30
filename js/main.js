const {
      OCR_API_URL,
      fetchWithTimeout,
      dataRepository,
      createSaveQueue
    } = window.JKGLData;
    const {
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
    } = window.JKGLCore;

    const defaultData = {
      packages: [],
      members: [],
      plans: [],
      dailyMonthRecords: [],
      dailyRecords: []
    };

    const dataSaveQueue = createSaveQueue({
      repository: dataRepository,
      debounceMs: 500,
      onError: (error) => console.error('同步数据到后端失败:', error)
    });

    const {
      parsePrice,
      preprocessImageForOcr,
      parseDetailItems,
      looksLikeDetailText
    } = window.JKGLPackageParser.createPackageParser({ uid, cleanName });

    const { createApp } = Vue;

    const app = createApp({
      data() {
        const parsed = dataRepository.readLocal(defaultData);
        return {
          dataReady: false,
          beforeUnloadHandler: null,
          view: 'packages',
          packages: parsed.packages || [],
          members: parsed.members || [],
          plans: parsed.plans || [],
          compareIds: [],
          selectedPackages: [],
          compareOnlyDiff: false,
          compareTabPackages: [],
          itemOcrDialogVisible: false,
          activeMemberId: parsed.members?.[0]?.id || '',
          planFilterId: '',
          ocrModeOptions: [
            { label: '识别内容', value: 'detail' }
          ],
          ocrQualityOptions: [
            { label: '快速', value: 'fast' },
            { label: '准确', value: 'accurate' }
          ],
          ocr: {
            mode: 'detail',
            quality: 'fast',
            file: null,
            imageUrl: '',
            rawText: '',
            running: false,
            progress: '',
            items: [],
            detailPackageId: '',
            detailPrice: 0,
            imageZoomed: false
          },
          packageEditor: {
            visible: false,
            editingId: '',
            form: { name: '', audience: '', price: 0, source: '手动录入' }
          },
          packageRemarkEditor: {
            visible: false,
            packageId: '',
            packageName: '',
            remark: ''
          },
          memberEditor: {
            visible: false,
            editingId: '',
            form: { name: '', gender: '', age: 0, focus: '' }
          },
          planCreator: {
            visible: false,
            packageId: '',
            name: ''
          },
          activeTab: 'packages',
          itemTabs: [],
          activeTimelineKey: '',
          isCreatingPlan: false,
          planCustomizerVisible: false,
          customizingPlan: null,
          selectedItemToAdd: '',
          planItemSearch: '',
          newPlanForm: {
            memberId: '',
            memberName: '',
            packageIds: [],
            examMonth: new Date().toISOString().slice(0, 7),
            enabled: true
          },
          planBasicEditor: {
            visible: false,
            editingId: '',
            form: {
              memberId: '',
              examMonth: '',
              enabled: true,
              basePackageName: ''
            }
          },
          trackingExcelDialogVisible: false,
          trackingExcel: {
            file: null,
            fileName: '',
            sheets: [],
            selectedSheet: '',
            workbook: null,
            items: [],
            planId: ''
          },
          activeDailyMemberId: parsed.members?.[0]?.id || '',
          activeDailyDepartment: '',
          dailyFilterYear: '',
          dailyFilterMonth: '',
          dailyExpandedRowIds: [],
          dailyMonthRecords: parsed.dailyMonthRecords || [],
          dailyRecords: parsed.dailyRecords || [],
          dailyReportDialog: {
            visible: false,
            row: null,
            activeType: 'lab',
            currentLabReportId: '',
            currentExamReportId: '',
            currentLabReport: null,
            currentExamReport: null,
            labMode: 'view',
            examMode: 'view',
            ocrRunning: false
          },
          dailyDeptEditor: {
            visible: false,
            memberId: '',
            departments: []
          },
          dailyEditor: {
            visible: false,
            form: { id: '', memberId: '', department: '', visitDate: '', doctor: '', content: '', notes: '' }
          }
        };
      },
      computed: {
        filteredAvailableItems() {
          if (!this.customizingPlan) return [];
          const member = this.members.find(m => m.id === this.customizingPlan.memberId);
          if (!member) return this.allAvailableItems;
          
          const gender = member.gender;
          if (gender !== '男' && gender !== '女') return this.allAvailableItems;
          
          return this.allAvailableItems.filter(item => {
            const name = item.name || '';
            
            // Find all packages containing this item
            const parentPkgs = this.packages.filter(pkg => 
              (pkg.items || []).some(i => i.name && i.name.trim() === name.trim())
            );
            
            if (parentPkgs.length === 0) return true; // Keep custom items
            
            // An item is allowed if at least one package containing it is compatible with the member's gender
            return parentPkgs.some(pkg => {
              const aud = pkg.audience || '';
              if (gender === '男') {
                // Compatible with male if it contains '男' or does not restrict to females ('女'/'妇')
                return aud.includes('男') || (!aud.includes('女') && !aud.includes('妇'));
              } else {
                // Compatible with female if it contains '女' or '妇' or does not restrict to males ('男')
                return aud.includes('女') || aud.includes('妇') || !aud.includes('男');
              }
            });
          });
        },
        allAvailableItems() {
          const map = new Map();
          this.packages.forEach(pkg => {
            (pkg.items || []).forEach(item => {
              if (!item.name) return;
              const key = item.name.trim();
              if (!map.has(key)) {
                map.set(key, {
                  key,
                  name: item.name,
                  category: item.category || '未分类',
                  price: Number(item.price || 0),
                  note: item.note || '',
                  source: pkg.name
                });
              } else {
                const existing = map.get(key);
                if (!String(existing.source || '').includes(pkg.name)) {
                  existing.source += ` / ${pkg.name}`;
                }
              }
            });
          });
          return Array.from(map.values());
        },
        sortedCustomizingPlanItems() {
          if (!this.customizingPlan || !this.customizingPlan.items) return [];
          return [...this.customizingPlan.items].sort((a, b) => {
            const getScore = (status) => {
              if (status === 'add') return 1;
              if (status === 'exclude') return 2;
              return 3;
            };
            const scoreA = getScore(a.status);
            const scoreB = getScore(b.status);
            if (scoreA !== scoreB) return scoreA - scoreB;
            return (a.category || '').localeCompare(b.category || '');
          });
        },
        filteredCustomizingPlanItems() {
          const keyword = cleanName(this.planItemSearch);
          if (!keyword) return this.sortedCustomizingPlanItems;
          return this.sortedCustomizingPlanItems.filter((item) => {
            const haystack = cleanName(`${item.name || ''}${item.category || ''}${item.note || ''}${item.source || ''}${this.planStatusLabel(item.status)}`);
            return haystack.includes(keyword);
          });
        },
        dailyMonthsWithData() {
          const months = new Set();
          this.dailyMonthRecords.forEach((record) => {
            const month = normalizeDailyMonth(record.month);
            if (month) months.add(month);
          });
          this.dailyRecords.forEach((record) => {
            const month = normalizeDailyMonth(record.visitDate);
            if (month) months.add(month);
          });
          return months;
        },
        dailyAvailableYears() {
          return Array.from(this.dailyMonthsWithData)
            .map(month => month.slice(0, 4))
            .filter(Boolean)
            .filter((year, index, arr) => arr.indexOf(year) === index)
            .sort((a, b) => b.localeCompare(a));
        },
        dailyVisibleMonths() {
          const year = this.dailyFilterYear || '';
          return Array.from(this.dailyMonthsWithData)
            .filter(month => !year || month.startsWith(`${year}-`))
            .sort((a, b) => b.localeCompare(a))
            .map(month => ({
              value: month,
              label: year ? `${Number(month.slice(5, 7))}月` : `${month.slice(0, 4)}年${Number(month.slice(5, 7))}月`
            }));
        },
        enabledPlans() {
          return this.plans
            .filter((plan) => this.isPlanEnabled(plan))
            .map((plan) => {
              this.calculatePlanTotal(plan);
              return plan;
            })
            .sort((a, b) => {
              const monthCompare = String(a.examMonth || '').localeCompare(String(b.examMonth || ''));
              if (monthCompare !== 0) return monthCompare;
              return this.getMemberName(a.memberId).localeCompare(this.getMemberName(b.memberId), 'zh-CN');
            });
        },
        pageTitle() {
          return {
            packages: '体检套餐管理',
            plans: '体检规划',
            tracking: '体检分析',
            members: '家人管理'
          }[this.view];
        },
        pageDesc() {
          return {
            packages: '管理所有体检套餐，支持多选对比内容。',
            plans: '给家人选择基础套餐，并在此基础上增减内容。',
            tracking: '围绕启用计划分析体检结果和指标变化。',
            members: '维护家庭成员基础信息。'
          }[this.view];
        },
        totalItems() {
          return this.packages.reduce((sum, pkg) => sum + (pkg.items?.length || 0), 0);
        },
        compareTabItems() {
          const pkgs = this.compareTabPackages;
          if (!pkgs || pkgs.length === 0) return [];
          
          const map = new Map();
          pkgs.forEach((pkg) => {
            (pkg.items || []).forEach((item) => {
              const key = normalizeItemKey(item.name) || item.name;
              if (!map.has(key)) {
                map.set(key, {
                  key,
                  name: item.name,
                  category: item.category,
                  packageIds: new Set()
                });
              }
              map.get(key).packageIds.add(pkg.id);
            });
          });
          
          let itemsList = Array.from(map.values()).map(item => ({
            ...item,
            packageIds: Array.from(item.packageIds)
          }));
          
          if (this.compareOnlyDiff) {
            itemsList = itemsList.filter(item => item.packageIds.length < pkgs.length);
          }
          
          return itemsList.sort((a, b) => b.packageIds.length - a.packageIds.length || a.name.localeCompare(b.name, 'zh-CN'));
        },
        activeMember() {
          return this.members.find((member) => member.id === this.activeMemberId);
        },
        activeMemberPlans() {
          return this.plans.filter((plan) => plan.memberId === this.activeMemberId);
        },
        groupedPlans() {
          const groups = {};
          this.plans.forEach(plan => {
            const month = plan.examMonth || (plan.createdAt ? plan.createdAt.slice(0, 7).replace(/\\//g, '-') : new Date().toISOString().slice(0, 7));
            if (!groups[month]) {
              groups[month] = {
                month,
                plans: [],
                totalPrice: 0,
                totalItemsCount: 0
              };
            }
            const planTotal = plan.items.reduce((sum, item) => {
              if (item.status === 'exclude') return sum;
              return sum + Number(item.price || 0);
            }, 0);
            plan._totalPrice = planTotal;
            groups[month].plans.push(plan);
            groups[month].totalPrice += planTotal;
            groups[month].totalItemsCount += plan.items.length;
          });

          return Object.keys(groups)
            .sort((a, b) => b.localeCompare(a))
            .map(month => groups[month]);
        },
        isTimelineMonthActive() {
          return this.activeTimelineKey?.startsWith('month_');
        },
        isTimelinePlanActive() {
          return this.activeTimelineKey?.startsWith('plan_');
        },
        activeMonthSelected() {
          if (this.isTimelineMonthActive) {
            return this.activeTimelineKey.replace('month_', '');
          }
          return '';
        },
        activeMonthGroup() {
          const month = this.activeMonthSelected;
          if (!month) return null;
          return this.groupedPlans.find(g => g.month === month) || null;
        },
        activePlan() {
          if (this.isTimelinePlanActive) {
            const planId = this.activeTimelineKey.replace('plan_', '');
            return this.plans.find(p => p.id === planId) || null;
          }
          return null;
        },
        siblingPlansInActiveMonth() {
          if (!this.activePlan) return [];
          const month = this.activePlan.examMonth || (this.activePlan.createdAt ? this.activePlan.createdAt.slice(0, 7).replace(/\\//g, '-') : new Date().toISOString().slice(0, 7));
          return this.plans.filter(p => {
            const pMonth = p.examMonth || (p.createdAt ? p.createdAt.slice(0, 7).replace(/\\//g, '-') : new Date().toISOString().slice(0, 7));
            return pMonth === month;
          }).map(p => {
            const total = p.items.reduce((sum, item) => {
              if (item.status === 'exclude') return sum;
              return sum + Number(item.price || 0);
            }, 0);
            p._totalPrice = total;
            return p;
          });
        },
        selectedDetailPackageName() {
          const pkg = this.packages.find((item) => item.id === this.ocr.detailPackageId);
          return pkg?.name || this.ocr.detailPackageId || '';
        }
      },
      watch: {
        activeMemberId: {
          immediate: true,
          handler(newVal) {
            if (newVal) {
              const member = this.members.find(m => m.id === newVal);
              if (member) {
                const plans = this.plans.filter(p => p.memberId === member.id && this.isPlanEnabled(p)).sort((a, b) => b.examMonth.localeCompare(a.examMonth));
                if (plans.length > 0 && !member._activePlanId) {
                  member._activePlanId = plans[0].id;
                }
              }
            }
          }
        },
        view: {
          immediate: true,
          handler(newVal) {
            if (newVal === 'tracking' && this.activeMemberId) {
              const member = this.members.find(m => m.id === this.activeMemberId);
              if (member) {
                const plans = this.plans.filter(p => p.memberId === member.id && this.isPlanEnabled(p)).sort((a, b) => b.examMonth.localeCompare(a.examMonth));
                if (plans.length > 0 && !member._activePlanId) {
                  member._activePlanId = plans[0].id;
                }
              }
            }
          }
        },
        packages: { deep: true, handler: 'persist' },
        members: { deep: true, handler: 'persist' },
        plans: { deep: true, handler: 'persist' },
        dailyMonthRecords: { deep: true, handler: 'persist' },
        dailyRecords: { deep: true, handler: 'persist' },
        dailyFilterMonth() {
          this.onDailyMemberChange();
        },
        'ocr.rawText': {
          handler(newText) {
            if (this.ocr.running) return;
            this.parseRawText();
          }
        },
        'ocr.mode': {
          handler(mode) {
            this.ocr.quality = 'fast';
          }
        }
      },
      async mounted() {
        window.addEventListener('paste', this.onPasteImage);
        try {
          const data = await dataRepository.loadRemote(3000);
          this.hydratePersistedData(data);
        } catch (e) {
          console.warn('后端数据暂时不可用，已使用本地缓存。', e);
          this.hydratePersistedData({
            packages: this.packages,
            members: this.members,
            plans: this.plans,
            dailyMonthRecords: this.dailyMonthRecords,
            dailyRecords: this.dailyRecords
          });
        } finally {
          // Wait until hydration-triggered watchers have finished before enabling saves.
          await this.$nextTick();
          this.dataReady = true;
          try {
            dataRepository.writeLocal(this.buildPersistPayload());
          } catch (error) {
            console.error('本地缓存初始化失败:', error);
          }
          this.beforeUnloadHandler = () => dataSaveQueue.flushForUnload();
          window.addEventListener('beforeunload', this.beforeUnloadHandler);
        }
      },
      beforeUnmount() {
        window.removeEventListener('paste', this.onPasteImage);
        if (this.beforeUnloadHandler) {
          window.removeEventListener('beforeunload', this.beforeUnloadHandler);
        }
        dataSaveQueue.flushForUnload();
      },
      methods: {
        hydratePersistedData(data = {}) {
          this.packages = Array.isArray(data.packages) ? data.packages : [];
          this.members = Array.isArray(data.members) ? data.members : [];
          this.plans = Array.isArray(data.plans) ? data.plans : [];
          this.dailyMonthRecords = Array.isArray(data.dailyMonthRecords) ? data.dailyMonthRecords : [];
          this.dailyRecords = Array.isArray(data.dailyRecords) ? data.dailyRecords : [];
          this.ensureDailyMonthRecords();

          if (!this.members.some((member) => member.id === this.activeDailyMemberId)) {
            this.activeDailyMemberId = this.members[0]?.id || '';
          }
          if (!this.members.some((member) => member.id === this.activeMemberId)) {
            this.activeMemberId = this.members[0]?.id || '';
          }

          if (this.plans.length) {
            const months = this.plans
              .map((plan) => plan.examMonth || (plan.createdAt ? plan.createdAt.slice(0, 7).replace(/\\//g, '-') : new Date().toISOString().slice(0, 7)))
              .sort((a, b) => b.localeCompare(a));
            this.activeTimelineKey = `month_${months[0]}`;
          } else {
            this.activeTimelineKey = '';
          }
        },
        getDailyDepartments(memberId) {
          const member = this.members.find(m => m.id === memberId);
          if (!member) return [];

          const activeDepts = [...new Set(this.dailyMonthRecords
            .filter(r => r.memberId === memberId && this.isDailyMonthRowInFilter(r))
            .map(r => r.department)
            .filter(Boolean))];
          const allDepts = [...new Set([
            ...this.dailyMonthRecords.filter(r => r.memberId === memberId).map(r => r.department).filter(Boolean),
            ...this.dailyRecords.filter(r => r.memberId === memberId).map(r => r.department).filter(Boolean)
          ])];

          if (!member.dailyDepartments) member.dailyDepartments = [];
          allDepts.forEach(d => {
             if (!member.dailyDepartments.includes(d)) {
                 member.dailyDepartments.push(d);
             }
          });
          
          return activeDepts.sort((a, b) => {
             let indexA = member.dailyDepartments.indexOf(a);
             let indexB = member.dailyDepartments.indexOf(b);
             if (indexA === -1) indexA = 999;
             if (indexB === -1) indexB = 999;
             return indexA - indexB;
          });
        },
        isDailyRecordInMonth(record) {
          const month = normalizeDailyMonth(record?.visitDate);
          if (this.dailyFilterMonth) return month === this.dailyFilterMonth;
          if (this.dailyFilterYear) return month.startsWith(`${this.dailyFilterYear}-`);
          return true;
        },
        isDailyMonthRowInFilter(row) {
          const month = normalizeDailyMonth(row?.month);
          if (this.dailyFilterMonth) return month === this.dailyFilterMonth;
          if (this.dailyFilterYear) return month.startsWith(`${this.dailyFilterYear}-`);
          return true;
        },
        dailyMonthCellClass(date) {
          return this.dailyMonthsWithData.has(normalizeDailyMonth(date)) ? 'daily-month-has-data' : '';
        },
        getDailyMonthRows(memberId, dept) {
          return this.dailyMonthRecords
            .filter(row => row.memberId === memberId && row.department === dept && this.isDailyMonthRowInFilter(row))
            .sort((a, b) => String(b.month || '').localeCompare(String(a.month || '')));
        },
        onDailyYearChange() {
          if (this.dailyFilterMonth && this.dailyFilterYear && !this.dailyFilterMonth.startsWith(`${this.dailyFilterYear}-`)) {
            this.dailyFilterMonth = '';
          }
          this.onDailyMemberChange();
        },
        setDailyMonthFilter(month) {
          this.dailyFilterMonth = month || '';
          if (month) this.dailyFilterYear = month.slice(0, 4);
          this.onDailyMemberChange();
        },
        isDailyRowExpanded(id) {
          return this.dailyExpandedRowIds.includes(id);
        },
        toggleDailyRowExpanded(id) {
          if (!id) return;
          if (this.isDailyRowExpanded(id)) {
            this.dailyExpandedRowIds = this.dailyExpandedRowIds.filter(rowId => rowId !== id);
          } else {
            this.dailyExpandedRowIds.push(id);
          }
        },
        shouldShowDailyExpand(row) {
          const text = `${row?.content || ''}\n${row?.notes || ''}\n${row?.remark || ''}`;
          return text.length > 180 || text.split(/\n/).length > 7;
        },
        ensureDailyMonthRecords() {
          const groups = new Map();
          this.dailyRecords.forEach(record => {
            const memberId = record.memberId;
            const department = (record.department || '未分类').trim();
            const month = normalizeDailyMonth(record.visitDate);
            if (!memberId || !month) return;
            const key = `${memberId}__${department}__${month}`;
            if (!groups.has(key)) groups.set(key, { memberId, department, month, records: [] });
            groups.get(key).records.push(record);
          });

          let added = 0;
          groups.forEach(group => {
            const exists = this.dailyMonthRecords.some(row =>
              row.memberId === group.memberId &&
              row.department === group.department &&
              normalizeDailyMonth(row.month) === group.month
            );
            if (exists) return;

            const records = group.records.sort((a, b) => String(a.visitDate || '').localeCompare(String(b.visitDate || '')));
            const content = records.map(record => {
              const date = normalizeDailyDate(record.visitDate);
              const label = date ? `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日` : '';
              const doctor = record.doctor ? ` ${record.doctor}` : '';
              const body = htmlToPlainText(record.content || '');
              return `${label}${doctor}${body ? `\n${body}` : ''}`.trim();
            }).filter(Boolean).join('\n\n');
            const notes = [...new Set(records.map(record => String(record.notes || '').trim()).filter(Boolean))].join('\n\n');

            this.dailyMonthRecords.push({
              id: uid('daily_month'),
              memberId: group.memberId,
              department: group.department,
              month: group.month,
              content,
              contentHtml: plainTextToHtml(content),
              notes,
              notesHtml: plainTextToHtml(notes),
              remark: '',
              remarkHtml: '',
              reports: [],
              source: 'legacy-dailyRecords',
              createdAt: nowText(),
              updatedAt: nowText()
            });
            added++;
          });
          if (added > 0) this.persist();
        },
        upsertDailyMonthRecord({ memberId, department, month, content, notes = '', remark, contentHtml, notesHtml, remarkHtml, source = 'manual' }) {
          const normalizedMonth = normalizeDailyMonth(month);
          const normalizedDept = (department || '未分类').trim();
          if (!memberId || !normalizedMonth) return null;
          const plainContent = String(content || '').trim();
          const plainNotes = String(notes || '').trim();
          const plainRemark = String(remark || '').trim();
          const safeContentHtml = sanitizeRichHtml(contentHtml || plainTextToHtml(plainContent));
          const safeNotesHtml = sanitizeRichHtml(notesHtml || plainTextToHtml(plainNotes));
          const safeRemarkHtml = sanitizeRichHtml(remarkHtml || plainTextToHtml(plainRemark));
          const existing = this.dailyMonthRecords.find(row =>
            row.memberId === memberId &&
            row.department === normalizedDept &&
            normalizeDailyMonth(row.month) === normalizedMonth
          );
          if (existing) {
            existing.month = normalizedMonth;
            if (plainContent || safeContentHtml) {
              existing.content = plainContent;
              existing.contentHtml = safeContentHtml || plainTextToHtml(existing.content);
            } else if (!existing.contentHtml && existing.content) {
              existing.contentHtml = plainTextToHtml(existing.content);
            }
            if (plainNotes || safeNotesHtml) {
              existing.notes = plainNotes;
              existing.notesHtml = safeNotesHtml || plainTextToHtml(existing.notes);
            } else if (!existing.notesHtml && existing.notes) {
              existing.notesHtml = plainTextToHtml(existing.notes);
            }
            if (remark !== undefined && (plainRemark || safeRemarkHtml)) {
              existing.remark = plainRemark;
              existing.remarkHtml = safeRemarkHtml || plainTextToHtml(existing.remark);
            } else if (!existing.remarkHtml && existing.remark) {
              existing.remarkHtml = plainTextToHtml(existing.remark);
            }
            existing.reports = existing.reports || [];
            existing.source = source;
            existing.updatedAt = nowText();
            return existing;
          }
          const row = {
            id: uid('daily_month'),
            memberId,
            department: normalizedDept,
            month: normalizedMonth,
            content: plainContent,
            contentHtml: safeContentHtml || plainTextToHtml(plainContent),
            notes: plainNotes,
            notesHtml: safeNotesHtml || plainTextToHtml(plainNotes),
            remark: plainRemark,
            remarkHtml: safeRemarkHtml || plainTextToHtml(plainRemark),
            reports: [],
            source,
            createdAt: nowText(),
            updatedAt: nowText()
          };
          this.dailyMonthRecords.push(row);
          return row;
        },
        addDailyMonthRow() {
          const memberId = this.activeDailyMemberId || this.members[0]?.id;
          if (!memberId) {
            ElementPlus.ElMessage.warning('请先添加家人');
            return;
          }
          const month = this.dailyFilterMonth || new Date().toISOString().slice(0, 7);
          const department = this.activeDailyDepartment || this.getDailyDepartments(memberId)[0] || '未分类';
          const existing = this.dailyMonthRecords.find(row =>
            row.memberId === memberId &&
            row.department === department &&
            normalizeDailyMonth(row.month) === month
          );
          if (existing) {
            this.dailyFilterMonth = month;
            this.activeDailyDepartment = department;
            ElementPlus.ElMessage.info('该月份已存在，已定位到原记录');
            return;
          }
          this.dailyMonthRecords.push({
            id: uid('daily_month'),
            memberId,
            department,
            month,
            content: '',
            contentHtml: '',
            notes: '',
            notesHtml: '',
            remark: '',
            remarkHtml: '',
            reports: [],
            source: 'manual',
            createdAt: nowText(),
            updatedAt: nowText()
          });
          this.persist();
          this.onDailyMemberChange();
          this.activeDailyDepartment = department;
        },
        getDailyRichHtml(row, field) {
          const htmlField = `${field}Html`;
          return sanitizeRichHtml(row?.[htmlField] || plainTextToHtml(row?.[field] || ''));
        },
        updateDailyRichField(row, field, event) {
          if (!row) return;
          const html = sanitizeRichHtml(event.target.innerHTML || '');
          row[`${field}Html`] = html;
          row[field] = htmlToPlainText(html);
          row.updatedAt = nowText();
        },
        touchDailyMonthRow(row) {
          if (!row) return;
          row.month = normalizeDailyMonth(row.month) || row.month;
          ['content', 'notes', 'remark'].forEach(field => {
            const htmlField = `${field}Html`;
            if (!row[htmlField] && row[field]) row[htmlField] = plainTextToHtml(row[field]);
          });
          row.reports = row.reports || [];
          row.updatedAt = nowText();
          this.persist();
        },
        onDailyMonthRowChange(row) {
          this.touchDailyMonthRow(row);
          this.onDailyMemberChange();
        },
        deleteDailyMonthRow(id) {
          ElementPlus.ElMessageBox.confirm('确定要删除这个月份的台账记录吗？', '提示', { type: 'warning' }).then(() => {
            this.dailyMonthRecords = this.dailyMonthRecords.filter(row => row.id !== id);
            this.persist();
            this.onDailyMemberChange();
            ElementPlus.ElMessage.success('已删除');
          }).catch(() => {});
        },
        getDailyReportType(report, fallbackType = 'lab') {
          const rawType = String(report?.reportType || report?.category || report?.type || fallbackType || 'lab').trim();
          if (['exam', '检查报告', '检查', '影像报告'].includes(rawType)) return 'exam';
          return 'lab';
        },
        normalizeMetricName(name) {
          return String(name || '')
            .replace(/\s+/g, '')
            .replace(/[（(].*?[）)]/g, '')
            .toLowerCase();
        },
        parseMetricNumber(value) {
          const match = String(value || '').match(/[<>≤≥]?\s*(-?\d+(?:\.\d+)?)/);
          return match ? Number(match[1]) : null;
        },
        parseReferenceRange(reference) {
          const text = String(reference || '').replace(/\s+/g, '').replace(/[（(]/g, '').replace(/[）)]/g, '');
          if (!text) return { type: 'empty', text: '' };
          const range = text.match(/^([<>≤≥]?-?\d+(?:\.\d+)?)[~～\-至]([<>≤≥]?-?\d+(?:\.\d+)?)$/);
          if (range) {
            return {
              type: 'range',
              text,
              low: Number(String(range[1]).replace(/[<>≤≥]/g, '')),
              high: Number(String(range[2]).replace(/[<>≤≥]/g, ''))
            };
          }
          const limit = text.match(/^([<>≤≥])(-?\d+(?:\.\d+)?)$/);
          if (limit) {
            return { type: 'limit', text, operator: limit[1], value: Number(limit[2]) };
          }
          return { type: 'qualitative', text };
        },
        normalizeLabItemForStorage(item) {
          const referenceRange = this.parseReferenceRange(item.reference || '');
          const valueNumber = this.parseMetricNumber(item.value || '');
          return {
            id: item.id || uid('lab_item'),
            name: item.name || item.project || item.itemName || '',
            normalizedName: this.normalizeMetricName(item.name || item.project || item.itemName || ''),
            value: item.value || item.result || '',
            valueText: String(item.value || item.result || ''),
            valueNumber,
            valueType: valueNumber === null ? 'text' : 'number',
            reference: item.reference || item.referenceRange || '',
            referenceRange,
            flag: item.flag || item.status || 'pending',
            unit: item.unit || '',
            note: item.note || item.remark || ''
          };
        },
        enrichDailyReportForStorage(report, fallbackType = 'lab') {
          const reportType = this.getDailyReportType(report, fallbackType);
          const base = {
            ...report,
            schemaVersion: 2,
            reportType,
            meta: {
              title: report.title || '',
              reportDate: report.reportDate || '',
              department: report.department || '',
              sampleType: report.sampleType || '',
              reportDoctor: report.reportDoctor || '',
              reviewDoctor: report.reviewDoctor || '',
              status: report.status || 'draft',
              confirmedAt: report.confirmedAt || ''
            },
            source: {
              kind: (report.files || []).length > 0 ? 'ocr-image' : (report.rawOcrText ? 'ocr-text' : 'manual'),
              rawOcrText: report.rawOcrText || '',
              files: report.files || []
            }
          };
          if (reportType === 'exam') {
            base.structured = {
              type: 'exam',
              title: report.title || '',
              reportDate: report.reportDate || '',
              sections: [
                { key: 'finding', title: '检查所见', text: this.formatExamReportText(report.findingText || '') },
                { key: 'conclusion', title: '检查结论/诊断', text: this.formatExamReportText(report.conclusionText || '') }
              ],
              doctors: {
                reportDoctor: report.reportDoctor || '',
                reviewDoctor: report.reviewDoctor || ''
              }
            };
            return base;
          }
          const metrics = Array.isArray(report.items)
            ? report.items.map(item => this.normalizeLabItemForStorage(item))
            : [];
          base.items = metrics;
          base.structured = {
            type: 'lab',
            title: report.title || '',
            reportDate: report.reportDate || '',
            sampleType: report.sampleType || '',
            metrics
          };
          return base;
        },
        normalizeDailyReport(report, fallbackType = 'lab') {
          const reportType = this.getDailyReportType(report, fallbackType);
          if (reportType === 'exam') {
            return this.enrichDailyReportForStorage({
              id: report.id || uid('daily_report'),
              reportType: 'exam',
              title: report.title || report.name || '',
              reportDate: report.reportDate || report.date || '',
              department: report.department || '',
              reportDoctor: report.reportDoctor || '',
              reviewDoctor: report.reviewDoctor || '',
              rawOcrText: report.rawOcrText || '',
              findingText: report.findingText || report.finding || '',
              conclusionText: report.conclusionText || report.conclusion || '',
              status: report.status || 'draft',
              confirmedAt: report.confirmedAt || '',
              files: report.files || [],
              createdAt: report.createdAt || nowText(),
              updatedAt: report.updatedAt || nowText()
            }, 'exam');
          }
          return this.enrichDailyReportForStorage({
            id: report.id || uid('daily_report'),
            reportType: 'lab',
            title: report.title || report.name || '',
            reportDate: report.reportDate || report.date || '',
            department: report.department || '',
            sampleType: report.sampleType || '',
            rawOcrText: report.rawOcrText || '',
            items: Array.isArray(report.items) ? report.items.map(item => this.normalizeLabItemForStorage(item)) : [],
            status: report.status || 'draft',
            confirmedAt: report.confirmedAt || '',
            files: report.files || [],
            createdAt: report.createdAt || nowText(),
            updatedAt: report.updatedAt || nowText()
          }, 'lab');
        },
        ensureDailyReports(row) {
          if (!row) return [];
          row.reports = (row.reports || []).map(report => this.normalizeDailyReport(report, this.getDailyReportType(report, 'lab')));
          return row.reports;
        },
        getDailyReportCount(row, type) {
          return (row?.reports || []).filter(report => this.getDailyReportType(report, 'lab') === type).length;
        },
        openDailyReportDialog(row) {
          this.ensureDailyReports(row);
          this.dailyReportDialog.row = row;
          this.dailyReportDialog.activeType = this.getDailyReportCount(row, 'lab') > 0 || this.getDailyReportCount(row, 'exam') === 0 ? 'lab' : 'exam';
          const lab = row.reports.find(report => report.reportType === 'lab');
          const exam = row.reports.find(report => report.reportType === 'exam');
          this.dailyReportDialog.currentLabReportId = lab?.id || '';
          this.dailyReportDialog.currentExamReportId = exam?.id || '';
          this.dailyReportDialog.currentLabReport = lab || null;
          this.dailyReportDialog.currentExamReport = exam || null;
          this.dailyReportDialog.labMode = 'view';
          this.dailyReportDialog.examMode = 'view';
          this.dailyReportDialog.visible = true;
        },
        getDailyReportsByType(type) {
          const row = this.dailyReportDialog.row;
          if (!row) return [];
          return row.reports.filter(report => report.reportType === type);
        },
        setActiveDailyReport(report) {
          if (!report) return;
          if (report.reportType === 'exam') {
            this.dailyReportDialog.currentExamReportId = report.id;
            this.dailyReportDialog.currentExamReport = report;
            this.dailyReportDialog.examMode = 'view';
          } else {
            this.dailyReportDialog.currentLabReportId = report.id;
            this.dailyReportDialog.currentLabReport = report;
            this.dailyReportDialog.labMode = 'view';
          }
        },
        getActiveDailyReport(type) {
          const id = type === 'exam' ? this.dailyReportDialog.currentExamReportId : this.dailyReportDialog.currentLabReportId;
          const current = type === 'exam' ? this.dailyReportDialog.currentExamReport : this.dailyReportDialog.currentLabReport;
          return current?.id === id ? current : this.getDailyReportsByType(type).find(report => report.id === id) || null;
        },
        createDailyReport(type) {
          const row = this.dailyReportDialog.row;
          if (!row) return null;
          this.ensureDailyReports(row);
          const report = this.normalizeDailyReport({
            reportType: type,
            title: type === 'lab' ? '新检验报告' : '新检查报告',
            reportDate: row.month ? `${row.month}-01` : '',
            department: row.department || '',
            status: 'draft'
          }, type);
          row.reports.push(report);
          this.setActiveDailyReport(report);
          this.dailyReportDialog.activeType = type;
          if (type === 'exam') {
            this.dailyReportDialog.examMode = 'parse';
          } else {
            this.dailyReportDialog.labMode = 'parse';
          }
          this.touchDailyReport();
          return report;
        },
        deleteDailyReport(report) {
          const row = this.dailyReportDialog.row;
          if (!row || !report) return;
          ElementPlus.ElMessageBox.confirm('确定删除这份报告吗？', '提示', { type: 'warning' }).then(() => {
            row.reports = (row.reports || []).filter(item => item.id !== report.id);
            const next = row.reports.find(item => item.reportType === report.reportType);
            if (next) {
              this.setActiveDailyReport(next);
            } else if (report.reportType === 'lab') {
              this.dailyReportDialog.currentLabReportId = '';
              this.dailyReportDialog.currentLabReport = null;
            } else if (report.reportType === 'exam') {
              this.dailyReportDialog.currentExamReportId = '';
              this.dailyReportDialog.currentExamReport = null;
            }
            this.touchDailyReport();
          }).catch(() => {});
        },
        addDailyLabItem(report) {
          if (!report) return;
          if (!Array.isArray(report.items)) report.items = [];
          report.items.push({
            id: uid('lab_item'),
            name: '',
            value: '',
            reference: '',
            flag: 'pending',
            unit: '',
            note: ''
          });
          this.touchDailyReport();
        },
        deleteDailyLabItem(report, index) {
          if (!report || !Array.isArray(report.items)) return;
          report.items.splice(index, 1);
          this.touchDailyReport();
        },
        confirmDailyReport(report) {
          if (!report) return;
          if (report.reportType === 'lab' && (!report.items || report.items.length === 0)) {
            ElementPlus.ElMessage.warning('请先解析或手动新增指标，再确认报告。');
            return;
          }
          report.status = 'confirmed';
          report.confirmedAt = nowText();
          if (report.reportType === 'exam') {
            this.dailyReportDialog.examMode = 'view';
          } else {
            this.dailyReportDialog.labMode = 'view';
          }
          this.touchDailyReport();
          ElementPlus.ElMessage.success('报告已确认。');
        },
        editDailyReport(report) {
          if (!report) return;
          if (report.reportType === 'exam') {
            this.dailyReportDialog.examMode = 'parse';
          } else {
            this.dailyReportDialog.labMode = 'parse';
          }
        },
        viewDailyReport(report) {
          if (!report) return;
          if (report.reportType === 'exam') {
            this.dailyReportDialog.examMode = 'view';
          } else {
            this.dailyReportDialog.labMode = 'view';
          }
        },
        triggerDailyReportOcr(type) {
          const inputRef = type === 'exam' ? 'dailyExamReportFileInput' : 'dailyLabReportFileInput';
          const input = this.$refs[inputRef];
          const el = Array.isArray(input) ? input[0] : input;
          el?.click();
        },
        async onDailyReportOcrFileChange(event, type) {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          const report = this.getOrCreateDailyReport(type);
          await this.runDailyReportOcr(report, file, type);
        },
        getOrCreateDailyReport(type) {
          let report = type === 'exam' ? this.dailyReportDialog.currentExamReport : this.dailyReportDialog.currentLabReport;
          if (!report && this.dailyReportDialog.row) {
            report = this.createDailyReport(type);
          }
          return report;
        },
        async onDailyReportPaste(event, type) {
          const report = this.getOrCreateDailyReport(type);
          if (!report) return;
          const items = Array.from(event.clipboardData?.items || []);
          const imageItem = items.find(item => item.type?.startsWith('image/'));
          if (imageItem) {
            const file = imageItem.getAsFile();
            if (!file) return;
            await this.runDailyReportOcr(report, new File([file], `wechat-paste-${Date.now()}.png`, { type: file.type || 'image/png' }), type);
            return;
          }
          const text = event.clipboardData?.getData('text/plain')?.trim();
          if (!text) {
            ElementPlus.ElMessage.warning('没有读取到截图或文字，请重新复制后再粘贴。');
            return;
          }
          const redactedText = this.redactPrivacy(text);
          report.rawOcrText = report.rawOcrText ? `${report.rawOcrText}\n${redactedText}` : redactedText;
          if (type === 'exam') {
            this.parseDailyExamReport(report);
          } else {
            this.parseDailyLabReport(report);
          }
          this.touchDailyReport();
          ElementPlus.ElMessage.success('已粘贴文字并解析，请核对。');
        },
        async runDailyReportOcr(report, file, type) {
          if (!report || !file) return;
          const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
          if (isPdf) {
            ElementPlus.ElMessage.warning('当前日常报告请先上传截图图片；PDF 需要后续接入页面转图后再解析。');
            return;
          }
          this.dailyReportDialog.ocrRunning = true;
          try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('mode', 'detail');
            formData.append('quality', 'accurate');
            const response = await fetch(OCR_API_URL, { method: 'POST', body: formData });
            if (!response.ok) throw new Error(await response.text());
            const data = await response.json();
            report.rawOcrText = this.redactPrivacy(data.rawText || '');
            report.files = report.files || [];
            report.files.push({
              id: uid('report_file'),
              name: file.name,
              type: file.type || 'image',
              size: file.size || 0,
              uploadedAt: nowText()
            });
            if (type === 'exam') {
              this.parseDailyExamReport(report);
            } else {
              this.parseDailyLabReport(report);
            }
            report.status = 'parsed';
            this.touchDailyReport();
            ElementPlus.ElMessage.success('截图 OCR 已写入并解析，请核对。');
          } catch (error) {
            console.error(error);
            ElementPlus.ElMessage.error('本地 OCR 调用失败，请确认 backend 服务已启动。');
          } finally {
            this.dailyReportDialog.ocrRunning = false;
          }
        },
        touchDailyReport() {
          const row = this.dailyReportDialog.row;
          if (!row) return;
          row.updatedAt = nowText();
          (row.reports || []).forEach(report => {
            report.updatedAt = report.updatedAt || nowText();
          });
          this.persist();
        },
        ...window.JKGLDailyReportParser,
        openDailyDeptEditor() {
          const memberId = this.activeDailyMemberId || this.members[0]?.id;
          if (!memberId) return;
          const member = this.members.find(m => m.id === memberId);
          const actualDepts = [...new Set(
            this.dailyMonthRecords
              .filter(row => row.memberId === memberId)
              .map(row => (row.department || '').trim())
              .filter(Boolean)
          )];
          const orderedDepts = actualDepts.sort((a, b) => {
            const order = member?.dailyDepartments || [];
            const indexA = order.indexOf(a);
            const indexB = order.indexOf(b);
            if (indexA === -1 && indexB === -1) return a.localeCompare(b, 'zh-Hans-CN');
            if (indexA === -1) return 1;
            if (indexB === -1) return -1;
            return indexA - indexB;
          });
          this.dailyDeptEditor.memberId = memberId;
          this.dailyDeptEditor.departments = orderedDepts.map(d => ({ original: d, current: d }));
          this.dailyDeptEditor.visible = true;
        },
        moveDailyDept(index, direction) {
          const depts = this.dailyDeptEditor.departments;
          if (direction === -1 && index > 0) {
            const temp = depts[index];
            depts[index] = depts[index - 1];
            depts[index - 1] = temp;
          } else if (direction === 1 && index < depts.length - 1) {
            const temp = depts[index];
            depts[index] = depts[index + 1];
            depts[index + 1] = temp;
          }
        },
        saveDailyDeptEditor() {
          const member = this.members.find(m => m.id === this.dailyDeptEditor.memberId);
          if (!member) return;
          this.dailyDeptEditor.departments.forEach(dept => {
             const orig = (dept.original || '').trim();
             const curr = (dept.current || '').trim();
             if (orig && curr && orig !== curr) {
                this.dailyRecords.forEach(r => {
                   if (r.memberId === member.id && r.department === orig) {
                      r.department = curr;
                   }
                });
                this.dailyMonthRecords.forEach(r => {
                   if (r.memberId === member.id && r.department === orig) {
                      r.department = curr;
                   }
                });
             }
          });
          member.dailyDepartments = this.dailyDeptEditor.departments.map(d => (d.current || '').trim()).filter(Boolean);
          this.persist();
          this.dailyDeptEditor.visible = false;
          this.onDailyMemberChange();
          ElementPlus.ElMessage.success('科室信息已保存');
        },
        getDailyRecords(memberId, dept) {
          return this.dailyRecords
            .filter(r => {
              if (r.memberId !== memberId || r.department !== dept) return false;
              if (!this.isDailyRecordInMonth(r)) return false;
              return true;
            })
            .sort((a, b) => new Date(b.visitDate) - new Date(a.visitDate));
        },
        onDailyMemberChange() {
           const depts = this.getDailyDepartments(this.activeDailyMemberId);
           this.activeDailyDepartment = depts.length > 0 ? depts[0] : '';
        },
        openDailyEditor(record = null) {
          if (record) {
            this.dailyEditor.form = { ...record };
          } else {
            this.dailyEditor.form = {
              id: '',
              memberId: this.activeDailyMemberId || this.members[0]?.id,
              department: this.activeDailyDepartment || '',
              visitDate: new Date().toISOString().split('T')[0],
              doctor: '',
              content: '',
              notes: ''
            };
          }
          this.dailyEditor.visible = true;
        },
        async initWangEditor() {
          try {
            await Promise.all([
              loadStyleOnce('wang-editor-style', 'https://unpkg.com/@wangeditor/editor@latest/dist/css/style.css'),
              loadScriptOnce('wang-editor-script', 'https://unpkg.com/@wangeditor/editor@latest/dist/index.js')
            ]);
            await this.$nextTick();
            if (!window.wangEditor) return;
            const { createEditor, createToolbar } = window.wangEditor;
            document.getElementById('wang-toolbar').innerHTML = '';
            document.getElementById('wang-editor').innerHTML = '';
            
            let htmlContent = this.dailyEditor.form.content || '<p><br></p>';
            if (htmlContent && !/<[a-z][\s\S]*>/i.test(htmlContent)) {
               htmlContent = htmlContent.replace(/\n/g, '<br/>');
            }

            this.wangEditorInstance = createEditor({
              selector: '#wang-editor',
              html: htmlContent,
              config: {
                placeholder: '诊断、用药、复查建议等...',
                onChange: (editor) => {
                  this.dailyEditor.form.content = editor.getHtml();
                }
              }
            });

            this.wangToolbarInstance = createToolbar({
              editor: this.wangEditorInstance,
              selector: '#wang-toolbar',
              config: {
                toolbarKeys: ['bold', 'underline', 'italic', 'color', 'bgColor', '|', 'bulletedList', 'numberedList', '|', 'clearStyle']
              }
            });
          } catch (error) {
            console.error(error);
            ElementPlus.ElMessage.error('富文本编辑器加载失败，请检查网络后重试。');
          }
        },
        destroyWangEditor() {
          if (this.wangEditorInstance) {
            this.wangEditorInstance.destroy();
            this.wangEditorInstance = null;
          }
          if (this.wangToolbarInstance) {
            this.wangToolbarInstance.destroy();
            this.wangToolbarInstance = null;
          }
        },
        saveDailyRecord() {
          if (!this.dailyEditor.form.department || !this.dailyEditor.form.visitDate) {
            ElementPlus.ElMessage.warning('请填写科室和日期');
            return;
          }
          if (this.dailyEditor.form.id) {
            const index = this.dailyRecords.findIndex(r => r.id === this.dailyEditor.form.id);
            if (index !== -1) {
              this.dailyRecords[index] = { ...this.dailyEditor.form };
            }
          } else {
            this.dailyRecords.push({
              ...this.dailyEditor.form,
              id: 'daily_' + Date.now() + '_' + Math.floor(Math.random() * 1000)
            });
          }
          this.ensureDailyMonthRecords();
          this.dailyEditor.visible = false;
          this.persist();
          this.onDailyMemberChange();
        },
        deleteDailyRecord(id) {
          ElementPlus.ElMessageBox.confirm('确定要删除这条就诊记录吗？', '提示', { type: 'warning' }).then(() => {
            this.dailyRecords = this.dailyRecords.filter(r => r.id !== id);
            this.persist();
            this.onDailyMemberChange();
            ElementPlus.ElMessage.success('已删除');
          });
        },
        clearDailyTestData() {
          ElementPlus.ElMessageBox.confirm('这会清空当前所有家庭成员的日常就诊记录（主要用于测试导入功能）。确认清空？', '清空测试数据', { type: 'warning' }).then(() => {
            this.dailyRecords = [];
            this.dailyMonthRecords = [];
            this.persist();
            this.onDailyMemberChange();
            ElementPlus.ElMessage.success('就诊记录数据已清空');
          }).catch(() => {});
        },
        async importDailyFromExcel(e) {
          const file = e.target.files[0];
          if (!file) return;
          try {
            await loadScriptOnce('xlsx-script', 'vendor/xlsx.full.min.js');
          } catch (error) {
            console.error(error);
            ElementPlus.ElMessage.error('Excel导入库加载失败，请确认 vendor/xlsx.full.min.js 存在。');
            e.target.value = '';
            return;
          }
          const reader = new FileReader();
          reader.onload = (evt) => {
            try {
              const data = new Uint8Array(evt.target.result);
              const workbook = XLSX.read(data, { type: 'array', cellHTML: false, cellStyles: true });
              
              let importedCount = 0;
              let firstImportedTarget = null;
              const currentMemberId = this.activeDailyMemberId || this.members[0]?.id;
              if (!currentMemberId) {
                ElementPlus.ElMessage.warning('请先添加并选择家人后再导入。');
                e.target.value = '';
                return;
              }
              
              workbook.SheetNames.forEach(sheetName => {
                const worksheet = workbook.Sheets[sheetName];
                const json = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
                const header = (json[0] || []).map(cell => String(cell || '').trim());
                const monthHeader = header[0];
                const contentHeader = header[1];
                if (monthHeader !== '月份' || contentHeader !== '内容') return;
                
                let currentMonthStr = "";
                for (let i = 1; i < json.length; i++) {
                  const row = json[i];
                  if (!row || row.length === 0) continue;
                  const contentCellObject = worksheet[XLSX.utils.encode_cell({ r: i, c: 1 })];
                  const notesCellObject = worksheet[XLSX.utils.encode_cell({ r: i, c: 2 })];
                  const remarkCellObject = worksheet[XLSX.utils.encode_cell({ r: i, c: 3 })];
                  
                  if (row[0] !== undefined && row[0] !== null && String(row[0]).trim() !== '') {
                     currentMonthStr = row[0];
                  }
                  const currentNotes = cellToPlainText(notesCellObject);
                  const currentRemark = cellToPlainText(remarkCellObject);
                  
                  const contentCell = cellToPlainText(contentCellObject);
                  if (!contentCell && !currentNotes && !currentRemark) continue;

                  const month = normalizeDailyMonth(currentMonthStr);
                  if (!month) continue;
                  const importedRow = this.upsertDailyMonthRecord({
                    memberId: currentMemberId,
                    department: sheetName,
                    month,
                    content: contentCell,
                    notes: currentNotes,
                    remark: currentRemark,
                    contentHtml: cellToRichHtml(contentCellObject),
                    notesHtml: cellToRichHtml(notesCellObject),
                    remarkHtml: cellToRichHtml(remarkCellObject),
                    source: 'excel-import'
                  });
                  if (importedRow) {
                    if (!firstImportedTarget) {
                      firstImportedTarget = { department: importedRow.department, month: importedRow.month };
                    }
                    importedCount++;
                  }
                }
              });
              
              if (importedCount > 0) {
                 if (firstImportedTarget) {
                   this.dailyFilterYear = '';
                   this.dailyFilterMonth = '';
                   this.activeDailyDepartment = firstImportedTarget.department;
                 }
                 this.persist();
                 if (!this.activeDailyDepartment) this.onDailyMemberChange();
                 ElementPlus.ElMessage.success(`成功导入 ${importedCount} 条月度台账记录`);
              } else {
                 ElementPlus.ElMessage.warning('未能识别到任何记录，请检查Excel格式。');
              }
            } catch (err) {
              console.error(err);
              ElementPlus.ElMessage.error('Excel 导入失败: ' + err.message);
            }
            e.target.value = '';
          };
          reader.readAsArrayBuffer(file);
        },
        async exportDailyMonthExcel() {
          const memberId = this.activeDailyMemberId || this.members[0]?.id;
          const member = this.members.find(item => item.id === memberId);
          if (!memberId || !member) {
            ElementPlus.ElMessage.warning('请先选择家人');
            return;
          }
          const rows = this.dailyMonthRecords
            .filter(row => row.memberId === memberId)
            .filter(row => !this.activeDailyDepartment || row.department === this.activeDailyDepartment)
            .filter(row => this.isDailyMonthRowInFilter(row))
            .sort((a, b) => String(b.month || '').localeCompare(String(a.month || '')));
          if (rows.length === 0) {
            ElementPlus.ElMessage.warning('当前没有可导出的日常检查台账');
            return;
          }
          try {
            await loadScriptOnce('xlsx-script', 'vendor/xlsx.full.min.js');
          } catch (error) {
            console.error(error);
            ElementPlus.ElMessage.error('Excel导出库加载失败，请确认 vendor/xlsx.full.min.js 存在。');
            return;
          }
          const workbook = XLSX.utils.book_new();
          const grouped = new Map();
          rows.forEach(row => {
            const dept = row.department || '未分类';
            if (!grouped.has(dept)) grouped.set(dept, []);
            grouped.get(dept).push(row);
          });
          grouped.forEach((deptRows, dept) => {
            const sheetRows = [
              ['月份', '内容', '日常注意事项', '备注'],
              ...deptRows
                .sort((a, b) => String(b.month || '').localeCompare(String(a.month || '')))
                .map(row => [
                  row.month || '',
                  row.content || '',
                  row.notes || '',
                  row.remark || ''
                ])
            ];
            const sheet = XLSX.utils.aoa_to_sheet(sheetRows);
            sheet['!cols'] = [
              { wch: 14 },
              { wch: 72 },
              { wch: 38 },
              { wch: 42 }
            ];
            XLSX.utils.book_append_sheet(workbook, sheet, safeFilePart(dept).slice(0, 31) || '未分类');
          });
          XLSX.writeFile(workbook, `日常检查-${safeFilePart(member.name)}.xlsx`);
        },
        getMemberEnabledPlans(memberId) {
          return this.plans.filter(p => p.memberId === memberId && this.isPlanEnabled(p)).sort((a, b) => b.examMonth.localeCompare(a.examMonth));
        },
        openTrackingExcel(plan) {
          this.clearTrackingExcel();
          this.trackingExcel.planId = plan.id;
          this.trackingExcelDialogVisible = true;
        },
        clearTrackingExcel() {
          this.trackingExcel = {
            file: null,
            fileName: '',
            sheets: [],
            selectedSheet: '',
            workbook: null,
            items: [],
            planId: this.trackingExcel.planId
          };
        },
        async onTrackingExcelChange(event) {
          const file = event.target.files?.[0];
          if (!file) return;
          this.trackingExcel.file = file;
          this.trackingExcel.fileName = file.name;
          try {
            await loadScriptOnce('xlsx-script', 'vendor/xlsx.full.min.js');
          } catch (error) {
            console.error(error);
            ElementPlus.ElMessage.error('Excel导入库加载失败，请确认 vendor/xlsx.full.min.js 存在。');
            event.target.value = '';
            return;
          }
          
          const reader = new FileReader();
          reader.onload = (e) => {
            try {
              const data = new Uint8Array(e.target.result);
              const workbook = XLSX.read(data, { type: 'array' });
              this.trackingExcel.workbook = workbook;
              this.trackingExcel.sheets = workbook.SheetNames;
              if (workbook.SheetNames.length > 0) {
                this.trackingExcel.selectedSheet = workbook.SheetNames[0];
                this.parseSelectedExcelSheet();
              }
            } catch (err) {
              console.error(err);
              ElementPlus.ElMessage.error('读取 Excel 失败: ' + err.message);
            }
          };
          reader.readAsArrayBuffer(file);
          event.target.value = '';
        },
        onTrackingExcelSheetChange() {
          this.parseSelectedExcelSheet();
        },
        parseSelectedExcelSheet() {
          const wb = this.trackingExcel.workbook;
          const sheetName = this.trackingExcel.selectedSheet;
          if (!wb || !sheetName) return;
          
          const ws = wb.Sheets[sheetName];
          const sheetRows = XLSX.utils.sheet_to_json(ws, { header: 1 });
          
          let headerIndex = -1;
          const colMap = { name: -1, value: -1, unit: -1, reference: -1 };
          
          for (let r = 0; r < Math.min(sheetRows.length, 10); r++) {
            const row = sheetRows[r];
            if (!row || !Array.isArray(row)) continue;
            
            let foundName = -1;
            let foundValue = -1;
            let foundUnit = -1;
            let foundRef = -1;
            
            for (let c = 0; c < row.length; c++) {
              const val = String(row[c] || '').trim();
              if (!val) continue;
              
              if (/项目|指标|名称|检测项/i.test(val)) {
                foundName = c;
              } else if (/结果|测定值|数值|检测值|测定结果/i.test(val)) {
                foundValue = c;
              } else if (/单位/i.test(val)) {
                foundUnit = c;
              } else if (/参考|范围|区间|正常值/i.test(val)) {
                foundRef = c;
              }
            }
            
            if (foundName !== -1 && foundValue !== -1) {
              headerIndex = r;
              colMap.name = foundName;
              colMap.value = foundValue;
              colMap.unit = foundUnit;
              colMap.reference = foundRef;
              break;
            }
          }
          
          if (headerIndex === -1) {
            colMap.name = 0;
            colMap.value = 1;
            colMap.unit = 2;
            colMap.reference = 3;
            headerIndex = -1;
          }
          
          const parsed = [];
          for (let r = headerIndex + 1; r < sheetRows.length; r++) {
            const row = sheetRows[r];
            if (!row || row.length === 0) continue;
            
            const name = String(row[colMap.name] || '').trim();
            if (!name || name === 'undefined' || /姓名|年龄|性别|科室|医院|日期|诊断/.test(name)) continue;
            
            const value = String(row[colMap.value] === undefined ? '' : row[colMap.value]).trim();
            const unit = colMap.unit !== -1 ? String(row[colMap.unit] || '').trim() : '';
            const reference = colMap.reference !== -1 ? String(row[colMap.reference] || '').trim() : '';
            
            const autoStatus = this.autoEvaluateAbnormal(value, reference);
            
            parsed.push({
              id: uid('excel_metric'),
              name: name,
              value: value,
              unit: unit,
              reference: reference,
              status: autoStatus !== '-' ? autoStatus : 'normal',
              note: ''
            });
          }
          
          this.trackingExcel.items = parsed;
          if (parsed.length > 0) {
            ElementPlus.ElMessage.success(`成功解析工作表 "${sheetName}"，获取到 ${parsed.length} 个指标。`);
          } else {
            ElementPlus.ElMessage.warning(`未能在工作表 "${sheetName}" 中解析出有效指标，请检查内容。`);
          }
        },
        onTrackingExcelRowValChange(row) {
          const autoStatus = this.autoEvaluateAbnormal(row.value, row.reference);
          if (autoStatus !== '-') {
            row.status = autoStatus;
          }
        },
        addTrackingExcelRow() {
          this.trackingExcel.items.push({
            id: uid('excel_metric'),
            name: '',
            value: '',
            unit: '',
            reference: '',
            status: 'normal',
            note: ''
          });
        },
        confirmTrackingExcel() {
          const plan = this.plans.find(p => p.id === this.trackingExcel.planId);
          if (!plan) return;
          
          let matchCount = 0;
          let newCount = 0;
          const newItems = [];
          
          this.trackingExcel.items.forEach(excelItem => {
            if (!excelItem.name.trim()) return;
            const key = normalizeItemKey(excelItem.name);
            const existing = plan.items.find(i => i.status !== 'exclude' && normalizeItemKey(i.name) === key);
            
            if (existing) {
              existing.result = excelItem.value + (excelItem.unit ? ' ' + excelItem.unit : '');
              if (excelItem.reference) existing.reference = excelItem.reference;
              existing.abnormalStatus = excelItem.status;
              if (excelItem.note && excelItem.note.trim()) {
                existing.resultRemark = existing.resultRemark 
                  ? `${existing.resultRemark} \n ${excelItem.note}` 
                  : excelItem.note;
              }
              matchCount++;
            } else {
              newItems.push({
                id: uid('plan_item'),
                name: excelItem.name,
                category: 'Excel导入',
                price: 0,
                status: 'add',
                result: excelItem.value + (excelItem.unit ? ' ' + excelItem.unit : ''),
                reference: excelItem.reference,
                abnormalStatus: excelItem.status,
                suggestion: '',
                resultRemark: excelItem.note || ''
              });
              newCount++;
            }
          });
          
          if (newItems.length > 0) {
            plan.items.push(...newItems);
          }
          
          this.persist();
          this.trackingExcelDialogVisible = false;
          ElementPlus.ElMessage.success(`导入成功！更新已有指标 ${matchCount} 个，新增指标 ${newCount} 个。`);
        },
        autoEvaluateAbnormal(value, reference) {
          if (!value) return '-';
          if (/[↑↓HL*高低异常]/.test(String(value))) return 'abnormal';
          
          const v = parseFloat(String(value).replace(/[^\d.-]/g, ''));
          if (isNaN(v)) return '-';
          
          if (!reference) return '-';
          if (reference.includes('-') || reference.includes('~') || reference.includes('至')) {
            const parts = reference.split(/[-~至]/);
            if (parts.length >= 2) {
              const min = parseFloat(parts[0].replace(/[^\d.-]/g, ''));
              const max = parseFloat(parts[1].replace(/[^\d.-]/g, ''));
              if (!isNaN(min) && !isNaN(max)) {
                return (v < min || v > max) ? 'abnormal' : 'normal';
              }
            }
          } else if (reference.includes('<') || reference.includes('≤')) {
            const max = parseFloat(reference.replace(/[^\d.-]/g, ''));
            if (!isNaN(max)) return v > max ? 'abnormal' : 'normal';
          } else if (reference.includes('>')) {
            const min = parseFloat(reference.replace(/[^\d.-]/g, ''));
            if (!isNaN(min)) return v < min ? 'abnormal' : 'normal';
          } else if (reference.includes('≥')) {
            const min = parseFloat(reference.replace(/[^\d.-]/g, ''));
            if (!isNaN(min)) return v < min ? 'abnormal' : 'normal';
          }
          return '-';
        },

        buildPersistPayload() {
          const dailyMonthRecords = (this.dailyMonthRecords || []).map(row => ({
            ...row,
            reports: (row.reports || []).map(report => this.enrichDailyReportForStorage(report, this.getDailyReportType(report, 'lab')))
          }));
          return {
            schemaVersion: 2,
            packages: this.packages,
            members: this.members,
            plans: this.plans,
            dailyMonthRecords,
            dailyRecords: this.dailyRecords
          };
        },

        persist() {
          if (!this.dataReady) return;
          dataSaveQueue.schedule(() => this.buildPersistPayload());
        },
        openItemOcr(pkg) {
          this.clearOcr();
          this.ocr.mode = 'detail';
          this.ocr.quality = 'fast';
          this.ocr.detailPackageId = pkg.id;
          this.ocr.detailPrice = Number(pkg.price || 0);
          this.itemOcrDialogVisible = true;
        },
        handleSelectionChange(selection) {
          this.selectedPackages = selection;
        },
        onImageChange(event) {
          const file = event.target.files?.[0];
          if (!file) return;
          this.useImageFile(file);
          event.target.value = '';
        },
        onPasteImage(event) {
          if (event.defaultPrevented) return;
          const items = Array.from(event.clipboardData?.items || []);
          const imageItem = items.find((item) => item.type.startsWith('image/'));
          if (!imageItem) return;
          event.preventDefault();
          const file = imageItem.getAsFile();
          if (!file) return;
          if (this.dailyReportDialog.visible) {
            const type = this.dailyReportDialog.activeType || 'lab';
            const report = this.getOrCreateDailyReport(type);
            this.runDailyReportOcr(report, new File([file], `paste-${Date.now()}.png`, { type: file.type || 'image/png' }), type);
            return;
          }
          this.useImageFile(new File([file], `paste-${Date.now()}.png`, { type: file.type || 'image/png' }));
          ElementPlus.ElMessage.success('已粘贴截图，可以开始解析。');
        },
        async processPdfFile(file) {
          this.ocr.progress = '正在本地提取 PDF 文本...';
          try {
            await loadScriptOnce('pdfjs-script', 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js');
            const arrayBuffer = await file.arrayBuffer();
            const pdfjsLib = window['pdfjs-dist/build/pdf'];
            pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
            const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
            let fullText = '';
            for (let i = 1; i <= pdf.numPages; i++) {
              const page = await pdf.getPage(i);
              const textContent = await page.getTextContent();
              
              const items = textContent.items;
              const rows = {};
              items.forEach(item => {
                const y = Math.round(item.transform[5]);
                if (!rows[y]) rows[y] = [];
                rows[y].push(item);
              });
              
              const sortedY = Object.keys(rows).map(Number).sort((a, b) => b - a);
              for (const y of sortedY) {
                const rowItems = rows[y].sort((a, b) => a.transform[4] - b.transform[4]);
                let rowStr = '';
                rowItems.forEach((item, idx) => {
                  if (idx > 0) {
                     const prev = rowItems[idx-1];
                     if (item.transform[4] - (prev.transform[4] + prev.width) > 5) {
                         rowStr += ' ';
                     }
                  }
                  rowStr += item.str;
                });
                fullText += rowStr + '\n';
              }
              fullText += '\n';
            }
            this.ocr.rawText = fullText;
            this.ocr.progress = 'PDF提取完成，自动解析中...';
            this.parseRawText();
            setTimeout(() => { this.ocr.progress = ''; }, 2000);
          } catch (err) {
            console.error(err);
            ElementPlus.ElMessage.error('PDF 解析失败，请重试或改为手动截图。');
            this.ocr.progress = '';
          }
        },
        useImageFile(file) {
          this.ocr.file = file;
          this.ocr.progress = '';
          if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
            if (this.ocr.imageUrl) URL.revokeObjectURL(this.ocr.imageUrl);
            this.ocr.imageUrl = '';
            this.processPdfFile(file);
          } else {
            if (this.ocr.imageUrl) URL.revokeObjectURL(this.ocr.imageUrl);
            this.ocr.imageUrl = URL.createObjectURL(file);
          }
        },
        async runOcr() {
          if (!this.ocr.file) {
            ElementPlus.ElMessage.warning('请先添加或粘贴截图。');
            return;
          }
          this.ocr.running = true;
          this.ocr.progress = '正在调用本地 OCR...';
          
          try {
            const formData = new FormData();
            formData.append('file', this.ocr.file);
            formData.append('mode', this.ocr.mode);
            formData.append('quality', this.ocr.quality);
            
            const response = await fetch(OCR_API_URL, {
              method: 'POST',
              body: formData
            });
            
            if (!response.ok) {
              const message = await response.text();
              throw new Error(message || `HTTP ${response.status}`);
            }
            
            const data = await response.json();
            this.ocr.rawText = this.redactPrivacy(data.rawText || '');
            this.ocr.items = (data.items || []).map((item) => ({
              id: uid('item'),
              category: item.category || '未分类',
              name: item.name || '',
              price: Number(item.price || 0),
              note: item.note || '',
              source: item.source || 'OCR截图',
              reviewStatus: 'pending'
            }));
            this.ocr.detailPrice = Number(data.detailPrice || this.ocr.detailPrice || 0);
            if (!this.ocr.items.length) this.addParsedItem();
            this.ocr.progress = 'OCR 识别完成。';
            ElementPlus.ElMessage.success('OCR 识别完成，请核对识别结果。');
          } catch (error) {
            console.error(error);
            ElementPlus.ElMessage.error('本地 OCR 调用失败，请确认 backend 服务已启动。');
            this.ocr.progress = 'OCR 服务异常';
          } finally {
            this.ocr.running = false;
          }
        },
        parseRawText() {
          if (this.ocr.mode === 'tracking') {
            const lines = String(this.ocr.rawText || '').split(/\n+/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
            const parsed = [];
            lines.forEach(line => {
              const match = line.match(/^(.{2,32}?)\s+([<>]?\d+(?:\.\d+)?)\s*([A-Za-z%μµ\/\u4e00-\u9fa5]*)\s*(?:参考范围|参考值|范围|正常值)?[:：]?\s*([<>≤≥]?\s*\d+(?:\.\d+)?\s*[-~至]\s*[<>≤≥]?\s*\d+(?:\.\d+)?|[<>≤≥]\s*\d+(?:\.\d+)?)?/);
              if (match) {
                const name = match[1].replace(/^[\d\.\-、]+/, '').trim();
                const value = match[2].trim();
                const unit = match[3] ? match[3].trim() : '';
                const reference = match[4] ? match[4].trim() : '';
                parsed.push({
                  id: generateId(),
                  name: name,
                  result: unit ? `${value} ${unit}` : value,
                  reference: reference,
                  abnormalStatus: '-'
                });
              }
            });
            this.ocr.items = parsed;
          } else {
            this.ocr.items = parseDetailItems(this.ocr.rawText);
          }
          if (!this.ocr.items.length) this.addParsedItem();
        },
        clearOcr() {
          this.ocr.file = null;
          if (this.ocr.imageUrl) URL.revokeObjectURL(this.ocr.imageUrl);
          this.ocr.imageUrl = '';
          this.ocr.rawText = '';
          this.ocr.progress = '';
          this.ocr.items = [];
          this.ocr.detailPackageId = '';
          this.ocr.detailPrice = 0;
          this.ocr.imageZoomed = false;
        },
        addParsedItem() {
          this.ocr.items.push({
            id: uid('item'),
            category: '未分类',
            name: '',
            price: 0,
            note: '',
            source: 'OCR截图',
            reviewStatus: 'pending'
          });
        },
        insertParsedItem(index) {
          const category = index >= 0 && index < this.ocr.items.length ? this.ocr.items[index].category : '未分类';
          this.ocr.items.splice(index + 1, 0, {
            id: uid('item'),
            category: category,
            name: '',
            price: 0,
            note: '',
            source: 'OCR手工添加',
            updatedAt: new Date().toLocaleString()
          });
        },
        confirmDetailItems() {
          const packageNameOrId = this.ocr.detailPackageId;
          let pkg = this.packages.find((item) => item.id === packageNameOrId);
          if (!pkg) return;
          // 导入检查内容明细时，不需要修改套餐本身的价格，套餐价格仅在编辑套餐基本信息时维护
          pkg.rawText = this.ocr.rawText;
          
          const newItems = this.ocr.items
            .filter((item) => item.name.trim())
            .map((item) => ({ ...item, reviewStatus: 'confirmed' }));
          
          const activeTabObj = this.itemTabs.find(t => t.packageId === pkg.id);
          const targetList = activeTabObj ? activeTabObj.items : (pkg.items || (pkg.items = []));
          
          let addedCount = 0;
          let mergedCount = 0;
          
          newItems.forEach((newItem, idx) => {
            const newKey = normalizeItemKey(newItem.name);
            const exists = newKey ? targetList.find(x => normalizeItemKey(x.name) === newKey) : null;
            if (exists) {
              exists.price = newItem.price;
              exists.category = newItem.category;
              if (newItem.note && newItem.note.trim()) {
                const currentNote = exists.note || '';
                if (!currentNote.includes(newItem.note.trim())) {
                  exists.note = currentNote ? `${currentNote}；${newItem.note.trim()}` : newItem.note.trim();
                }
              }
              mergedCount++;
            } else {
              let insertIdx = -1;
              for (let i = idx - 1; i >= 0; i--) {
                const k = normalizeItemKey(newItems[i].name);
                const tIdx = k ? targetList.findIndex(x => normalizeItemKey(x.name) === k) : -1;
                if (tIdx !== -1) {
                  insertIdx = tIdx + 1;
                  break;
                }
              }
              if (insertIdx === -1) {
                for (let i = idx + 1; i < newItems.length; i++) {
                  const k = normalizeItemKey(newItems[i].name);
                  const tIdx = k ? targetList.findIndex(x => normalizeItemKey(x.name) === k) : -1;
                  if (tIdx !== -1) {
                    insertIdx = tIdx;
                    break;
                  }
                }
              }
              
              if (insertIdx !== -1) {
                targetList.splice(insertIdx, 0, newItem);
              } else {
                targetList.push(newItem);
              }
              addedCount++;
            }
          });
          
          if (!activeTabObj) {
            pkg.updatedAt = nowText();
          }
          this.itemOcrDialogVisible = false;
          if (mergedCount > 0) {
            ElementPlus.ElMessage.success(`导入完成：成功新增 ${addedCount} 个检查项目，自动去重并合并了 ${mergedCount} 个重叠项目。`);
          } else {
            ElementPlus.ElMessage.success(`导入完成：成功新增 ${addedCount} 个检查项目。`);
          }
        },
        openPackageEditor(pkg) {
          this.packageEditor.visible = true;
          this.packageEditor.editingId = pkg?.id || '';
          this.packageEditor.form = pkg
            ? { name: pkg.name, audience: pkg.audience, price: pkg.price, source: pkg.source }
            : { name: '', audience: '', price: 0, source: '手动录入' };
        },
        savePackageEditor() {
          const form = this.packageEditor.form;
          if (!form.name.trim()) {
            ElementPlus.ElMessage.warning('请填写套餐名称。');
            return;
          }
          if (this.packageEditor.editingId) {
            const pkg = this.packages.find((item) => item.id === this.packageEditor.editingId);
            Object.assign(pkg, form, { updatedAt: nowText() });
          } else {
            this.packages.push({
              id: uid('pkg'),
              ...form,
              items: [],
              rawText: '',
              updatedAt: nowText()
            });
          }
          this.packageEditor.visible = false;
        },
        openPackageRemarkEditor(pkg) {
          this.packageRemarkEditor = {
            visible: true,
            packageId: pkg.id,
            packageName: pkg.name,
            remark: pkg.remark || ''
          };
        },
        savePackageRemark() {
          const pkg = this.packages.find((item) => item.id === this.packageRemarkEditor.packageId);
          if (!pkg) return;
          pkg.remark = this.packageRemarkEditor.remark;
          pkg.updatedAt = nowText();
          this.packageRemarkEditor.visible = false;
          ElementPlus.ElMessage.success('套餐备注已保存。');
        },
        viewPackage(pkg) {
          const existing = this.itemTabs.find(tab => tab.packageId === pkg.id);
          if (!existing) {
            this.itemTabs.push({
              packageId: pkg.id,
              package: pkg,
              title: `内容明细: ${pkg.name}`,
              items: JSON.parse(JSON.stringify(pkg.items || [])),
              selectedItems: [],
              batchCategory: ''
            });
          }
          this.activeTab = `pkg_${pkg.id}`;
        },
        addTabItem(tab) {
          tab.items.push({
            id: uid('item'),
            category: '未分类',
            name: '',
            price: 0,
            note: '',
            source: '手动新增',
            updatedAt: new Date().toLocaleString()
          });
        },
        insertTabRow(tab, index) {
          const category = index >= 0 && index < tab.items.length ? tab.items[index].category : '未分类';
          tab.items.splice(index + 1, 0, {
            id: uid('item'),
            category: category,
            name: '',
            price: 0,
            note: '',
            source: '手动新增',
            updatedAt: new Date().toLocaleString()
          });
        },
        deleteTabRow(tab, row) {
          const idx = tab.items.findIndex(item => item.id === row.id);
          if (idx !== -1) {
            tab.items.splice(idx, 1);
          }
        },
        clearBlankTabItems(tab) {
          const originalCount = tab.items.length;
          const remaining = tab.items.filter(item => item.name && item.name.trim() !== '');
          tab.items.splice(0, tab.items.length, ...remaining);
          const cleared = originalCount - remaining.length;
          if (cleared > 0) {
            ElementPlus.ElMessage.success(`已清空 ${cleared} 个名称为空的空白行。请点击页面下方的“保存修改”使修改生效。`);
          } else {
            ElementPlus.ElMessage.info('未检测到名称为空的空白行。');
          }
        },
        handleTabSelectionChange(tab, selection) {
          tab.selectedItems = selection;
        },
        applyTabBatchCategory(tab) {
          const cat = tab.batchCategory.trim();
          if (!cat) {
            ElementPlus.ElMessage.warning('请输入新的科室名称。');
            return;
          }
          tab.selectedItems.forEach((item) => {
            item.category = cat;
          });
          ElementPlus.ElMessage.success(`已批量修改 ${tab.selectedItems.length} 个内容的分类为 "${cat}"。`);
          tab.batchCategory = '';
        },
        batchDeleteTabItems(tab) {
          ElementPlus.ElMessageBox.confirm(`确认批量删除已选中的 ${tab.selectedItems.length} 个内容？`, '批量删除', { type: 'warning' })
            .then(() => {
              const selectedIds = new Set(tab.selectedItems.map((item) => item.id));
              const remaining = tab.items.filter((item) => !selectedIds.has(item.id));
              tab.items.splice(0, tab.items.length, ...remaining);
              tab.selectedItems = [];
              ElementPlus.ElMessage.success('批量删除成功。');
            })
            .catch(() => {});
        },
        saveTabChanges(tab) {
          const pkg = tab.package;
          pkg.items = JSON.parse(JSON.stringify(tab.items));
          pkg.updatedAt = nowText();
          this.closeTab(pkg.id, false);
          ElementPlus.ElMessage.success(`套餐 "${pkg.name}" 的内容修改已成功保存并同步。`);
        },
        closeTab(pkgId, askConfirm = true) {
          const tabIdx = this.itemTabs.findIndex(t => t.packageId === pkgId);
          if (tabIdx === -1) return;
          const tab = this.itemTabs[tabIdx];
          const beforeStr = JSON.stringify(tab.package.items || []);
          const afterStr = JSON.stringify(tab.items);
          
          const doClose = () => {
            this.itemTabs.splice(tabIdx, 1);
            if (this.activeTab === `pkg_${pkgId}`) {
              this.activeTab = 'packages';
            }
          };
          
          if (askConfirm && beforeStr !== afterStr) {
            ElementPlus.ElMessageBox.confirm('有未保存的内容修改，确认放弃并关闭？', '放弃修改', { type: 'warning' })
              .then(() => {
                doClose();
              })
              .catch(() => {});
          } else {
            doClose();
          }
        },
        openCompareTab() {
          if (this.selectedPackages.length < 2) {
            ElementPlus.ElMessage.warning('请选择至少两个套餐进行对比。');
            return;
          }
          this.compareTabPackages = JSON.parse(JSON.stringify(this.selectedPackages));
          this.activeTab = 'compare';
        },
        closeCompareTab() {
          this.compareTabPackages = [];
          if (this.activeTab === 'compare') {
            this.activeTab = 'packages';
          }
        },
        handleTabRemove(tabName) {
          if (tabName === 'compare') {
            this.closeCompareTab();
          } else {
            const pkgId = tabName.replace('pkg_', '');
            this.closeTab(pkgId, true);
          }
        },
        deletePackage(id) {
          ElementPlus.ElMessageBox.confirm('删除套餐后，已生成的计划不会自动删除。确认删除？', '确认删除', { type: 'warning' })
            .then(() => {
              this.packages = this.packages.filter((pkg) => pkg.id !== id);
              this.selectedPackages = this.selectedPackages.filter((pkg) => pkg.id !== id);
            })
            .catch(() => {});
        },
        openMemberEditor(member) {
          this.memberEditor.visible = true;
          this.memberEditor.editingId = member?.id || '';
          this.memberEditor.form = member
            ? { name: member.name, gender: member.gender, age: member.age, focus: member.focus }
            : { name: '', gender: '', age: 0, focus: '' };
        },
        saveMemberEditor() {
          const form = this.memberEditor.form;
          if (!form.name.trim()) {
            ElementPlus.ElMessage.warning('请填写姓名。');
            return;
          }
          if (this.memberEditor.editingId) {
            const member = this.members.find((item) => item.id === this.memberEditor.editingId);
            Object.assign(member, form);
          } else {
            const member = { id: uid('member'), ...form };
            this.members.push(member);
            this.activeMemberId = member.id;
          }
          this.memberEditor.visible = false;
        },
        deleteMember(id) {
          ElementPlus.ElMessageBox.confirm('删除家人后，与之相关的体检计划也将被自动清除。确认删除？', '确认删除', { type: 'warning' })
            .then(() => {
              this.members = this.members.filter((m) => m.id !== id);
              this.plans = this.plans.filter((p) => p.memberId !== id);
              if (this.activeMemberId === id) {
                this.activeMemberId = this.members[0]?.id || '';
              }
              ElementPlus.ElMessage.success('家人及其关联的体检计划已删除。');
            })
            .catch(() => {});
        },
        getMemberPlans(memberId) {
          return this.plans
            .filter(p => p.memberId === memberId)
            .sort((a, b) => String(b.examMonth || '').localeCompare(String(a.examMonth || '')));
        },
        calculatePlanTotal(plan) {
          const total = (plan.items || []).reduce((sum, item) => {
            if (item.status === 'exclude') return sum;
            return sum + Number(item.price || 0);
          }, 0);
          plan._totalPrice = total;
          return total;
        },
        recalculatePlanTotal(plan) {
          this.calculatePlanTotal(plan);
          this.persist();
        },
        getPlanAddedCount(plan) {
          return (plan.items || []).filter(i => i.status === 'add').length;
        },
        getPlanAdditionsTotal(plan) {
          return (plan.items || []).filter(i => i.status === 'add').reduce((sum, i) => sum + Number(i.price || 0), 0);
        },
        getPlanExcludedCount(plan) {
          return (plan.items || []).filter(i => i.status === 'exclude').length;
        },
        getPlanExclusionsTotal(plan) {
          return (plan.items || []).filter(i => i.status === 'exclude').reduce((sum, i) => sum + Number(i.price || 0), 0);
        },
        isPlanEnabled(plan) {
          return plan?.enabled !== false;
        },
        setPlanEnabled(plan, value) {
          plan.enabled = Boolean(value);
          this.persist();
        },
        buildPlanName(memberId, examMonth) {
          const memberName = this.getMemberName(memberId);
          return `${memberName} ${examMonth || ''} 体检计划`.trim();
        },
        openPlanBasicEditor(plan) {
          this.planBasicEditor = {
            visible: true,
            editingId: plan.id,
            form: {
              memberId: plan.memberId || '',
              examMonth: plan.examMonth || new Date().toISOString().slice(0, 7),
              enabled: this.isPlanEnabled(plan),
              basePackageName: plan.basePackageName || ''
            }
          };
        },
        savePlanBasicEditor() {
          const form = this.planBasicEditor.form;
          if (!form.memberId) {
            ElementPlus.ElMessage.warning('请选择家人。');
            return;
          }
          if (!form.examMonth) {
            ElementPlus.ElMessage.warning('请选择计划月份。');
            return;
          }
          const plan = this.plans.find((item) => item.id === this.planBasicEditor.editingId);
          if (!plan) return;
          plan.memberId = form.memberId;
          plan.examMonth = form.examMonth;
          plan.name = this.buildPlanName(form.memberId, form.examMonth);
          plan.enabled = Boolean(form.enabled);
          plan.updatedAt = nowText();
          this.planBasicEditor.visible = false;
          this.persist();
          ElementPlus.ElMessage.success('体检计划信息已保存。');
        },
        getPlanPackageRemarks(plan) {
          const ids = plan?.packageIds?.length ? plan.packageIds : (plan?.packageId ? [plan.packageId] : []);
          return ids
            .map((id) => {
              const pkg = this.packages.find((item) => item.id === id);
              return pkg && pkg.remark ? { packageId: pkg.id, packageName: pkg.name, remark: pkg.remark } : null;
            })
            .filter(Boolean);
        },
        openPlanCreatorForMember(member) {
          this.newPlanForm = {
            memberId: member.id,
            memberName: member.name,
            packageIds: [],
            examMonth: new Date().toISOString().slice(0, 7),
            enabled: true
          };
          this.isCreatingPlan = true;
        },
        createPlanForMember() {
          const memberId = this.newPlanForm.memberId;
          const selectedPkgIds = this.newPlanForm.packageIds || [];
          
          const itemMap = new Map();
          const pkgNames = [];
          
          selectedPkgIds.forEach(pkgId => {
            const pkg = this.packages.find(p => p.id === pkgId);
            if (pkg) {
              pkgNames.push(pkg.name);
              (pkg.items || []).forEach(item => {
                const key = normalizeItemKey(item.name) || item.name;
                if (!itemMap.has(key)) {
                  itemMap.set(key, {
                    id: uid('plan_item'),
                    category: item.category,
                    name: item.name,
                    price: Number(item.price || 0),
                    note: item.note || '',
                    source: pkg.name,
                    status: 'include'
                  });
                } else {
                  const existing = itemMap.get(key);
                  if (!String(existing.source || '').includes(pkg.name)) {
                    existing.source += ` / ${pkg.name}`;
                  }
                }
              });
            }
          });
          
          const planName = this.buildPlanName(memberId, this.newPlanForm.examMonth);
          
          const plan = {
            id: uid('plan'),
            memberId: memberId,
            packageIds: selectedPkgIds,
            packageId: selectedPkgIds[0] || '',
            name: planName,
            basePackageName: pkgNames.join(' + '),
            examMonth: this.newPlanForm.examMonth,
            enabled: this.newPlanForm.enabled !== false,
            createdAt: nowText(),
            items: Array.from(itemMap.values())
          };
          
          this.calculatePlanTotal(plan);
          this.plans.push(plan);
          this.isCreatingPlan = false;
          this.persist();
          ElementPlus.ElMessage.success('计划创建成功');
        },
        openPlanCustomizerDialog(plan) {
          this.customizingPlan = plan;
          this.selectedItemToAdd = '';
          this.planItemSearch = '';
          this.planCustomizerVisible = true;
        },
        addItemToCustomizingPlan() {
          if (!this.customizingPlan || !this.selectedItemToAdd) return;
          const templateItem = this.allAvailableItems.find(i => i.key === this.selectedItemToAdd);
          if (templateItem) {
            this.customizingPlan.items.push({
              id: uid('plan_item'),
              category: templateItem.category,
              name: templateItem.name,
              price: templateItem.price,
              note: templateItem.note,
              source: templateItem.source,
              status: 'add'
            });
            this.calculatePlanTotal(this.customizingPlan);
            this.selectedItemToAdd = '';
            this.persist();
            ElementPlus.ElMessage.success('已成功添加新增项目');
          }
        },
        deleteItemFromCustomizingPlan(row) {
          if (!this.customizingPlan) return;
          const idx = this.customizingPlan.items.findIndex(i => i.id === row.id);
          if (idx > -1) {
            this.customizingPlan.items.splice(idx, 1);
            this.calculatePlanTotal(this.customizingPlan);
            this.persist();
          }
        },
        getMemberName(id) {
          const m = this.members.find(x => x.id === id);
          return m ? m.name : '未知';
        },
        formatRemarkSummary(value) {
          return String(value || '').replace(/\s+/g, ' ').trim();
        },
        getPlanName(id) {
          const plan = this.plans.find(x => x.id === id);
          return plan ? plan.name : '';
        },
        deletePlan(id) {
          const plan = this.plans.find((item) => item.id === id);
          ElementPlus.ElMessageBox.confirm(`确认删除体检计划「${plan?.name || ''}」？`, '确认删除', { type: 'warning' })
            .then(() => {
              this.plans = this.plans.filter((item) => item.id !== id);
              ElementPlus.ElMessage.success('体检计划已删除。');
            })
            .catch(() => {});
        },
        exportSinglePlanExcel(plan) {
          this.exportPlansExcel([plan]);
        },
        async exportPackagesExcel(packagesToExport) {
          try {
            await loadScriptOnce('xlsx-script', 'vendor/xlsx.full.min.js');
          } catch (error) {
            console.error(error);
            ElementPlus.ElMessage.error('Excel导出库加载失败，请确认 vendor/xlsx.full.min.js 存在。');
            return;
          }
          const headers = ['套餐名称', '适用人群', '套餐价格', '内容数', '分类/科室', '检查内容', '单项价格', '说明/备注', '项目来源', '更新时间', '套餐备注'];
          const rows = [];
          packagesToExport.forEach((pkg) => {
            const items = pkg.items && pkg.items.length ? pkg.items : [{}];
            items.forEach((item) => {
              rows.push({
                '套餐名称': pkg.name,
                '适用人群': pkg.audience || '通用',
                '套餐价格': Number(pkg.price || 0),
                '内容数': pkg.items ? pkg.items.length : 0,
                '分类/科室': item.category || '',
                '检查内容': item.name || '',
                '单项价格': item.price === undefined ? '' : Number(item.price || 0),
                '说明/备注': item.note || '',
                '项目来源': item.source || pkg.source || '',
                '更新时间': pkg.updatedAt || '',
                '套餐备注': pkg.remark || ''
              });
            });
          });
          const worksheet = XLSX.utils.json_to_sheet(rows, { header: headers });
          const workbook = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(workbook, worksheet, "套餐明细");
          worksheet['!cols'] = [
            { wch: 26 }, { wch: 12 }, { wch: 10 }, { wch: 8 }, { wch: 14 },
            { wch: 34 }, { wch: 10 }, { wch: 38 }, { wch: 18 }, { wch: 20 }, { wch: 42 }
          ];
          const filePrefix = packagesToExport.length === 1
            ? `jkgl-${safeFilePart(packagesToExport[0].name)}`
            : `jkgl-packages-${packagesToExport.length}`;
          XLSX.writeFile(workbook, `${filePrefix}-${Date.now()}.xlsx`);
          ElementPlus.ElMessage.success(`成功导出 ${packagesToExport.length} 个套餐，共 ${rows.length} 行明细。`);
        },
        async exportPlansExcel(plansToExport) {
          const headers = ['家人姓名', '计划时间', '计划名称', '原基础套餐', '预估最终总价', '项目属性', '科室分类', '检查项目名称', '单项价格', '说明/建议备注', '项目来源'];
          const rows = [];
          
          plansToExport.forEach((plan) => {
            const memberName = this.getMemberName(plan.memberId);
            const items = plan.items && plan.items.length ? plan.items : [{}];
            const planTotal = (plan.items || []).reduce((sum, item) => {
              if (item.status === 'exclude') return sum;
              return sum + Number(item.price || 0);
            }, 0);
            
            items.forEach((item) => {
              rows.push({
                '家人姓名': memberName,
                '计划时间': plan.examMonth || '未规划',
                '计划名称': plan.name,
                '原基础套餐': plan.basePackageName || '',
                '预估最终总价': planTotal,
                '项目属性': this.planStatusLabel(item.status),
                '科室分类': item.category || '',
                '检查项目名称': item.name || '',
                '单项价格': item.price === undefined ? 0 : Number(item.price || 0),
                '说明/建议备注': item.note || '',
                '项目来源': item.source || ''
              });
            });
          });

          try {
            await loadScriptOnce('xlsx-script', 'vendor/xlsx.full.min.js');
          } catch (error) {
            console.error(error);
            ElementPlus.ElMessage.error('Excel导出库加载失败，请确认 vendor/xlsx.full.min.js 存在。');
            return;
          }

          const worksheet = XLSX.utils.json_to_sheet(rows, { header: headers });
          const workbook = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(workbook, worksheet, "体检计划明细");

          // Set column widths
          worksheet['!cols'] = [
            { wch: 12 }, { wch: 12 }, { wch: 20 }, { wch: 20 }, { wch: 15 },
            { wch: 10 }, { wch: 12 }, { wch: 25 }, { wch: 10 }, { wch: 30 }, { wch: 15 }
          ];

          const filePrefix = plansToExport.length === 1
            ? `plan-${safeFilePart(this.getMemberName(plansToExport[0].memberId))}-${plansToExport[0].examMonth}`
            : `plans-month-${plansToExport[0].examMonth || 'all'}`;
          
          XLSX.writeFile(workbook, `${filePrefix}.xlsx`);
          ElementPlus.ElMessage.success(`成功导出 ${plansToExport.length} 个计划，共 ${rows.length} 行明细。`);
        },
        planStatusLabel(status) {
          return {
            include: '保留',
            add: '新增',
            exclude: '排除',
            pending: '待确认'
          }[status || 'include'] || '保留';
        },
        seedDemo() {
          if (this.packages.length || this.members.length) {
            ElementPlus.ElMessageBox.confirm('示例数据会追加到当前数据中，是否继续？', '填充示例', { type: 'info' })
              .then(() => this.addDemoData())
              .catch(() => {});
          } else {
            this.addDemoData();
          }
        },
        addDemoData() {
          const pkgA = {
            id: uid('pkg'),
            name: 'A套餐(基础版)-男性',
            audience: '男性',
            price: 597,
            source: '示例',
            updatedAt: nowText(),
            rawText: '',
            items: [
              { id: uid('item'), category: '检验科', name: '血常规（五分类）', price: 25, note: '感染性、血液性疾病等早期筛查' },
              { id: uid('item'), category: '检验科', name: '幽门螺旋杆菌尿素酶抗体检测（HP）', price: 50, note: '' },
              { id: uid('item'), category: '彩超室', name: '彩色B超（肝、胆、胰、脾）', price: 105, note: '' }
            ]
          };
          const pkgC = {
            id: uid('pkg'),
            name: 'C套餐(大众版)-男性',
            audience: '男性',
            price: 1619,
            source: '示例',
            updatedAt: nowText(),
            rawText: '',
            items: [
              { id: uid('item'), category: '检验科', name: '血常规（五分类）', price: 25, note: '感染性、血液性疾病等早期筛查' },
              { id: uid('item'), category: '检验科', name: '游离T3（FT3）', price: 50, note: '甲状腺功能测评' },
              { id: uid('item'), category: '放射科', name: 'CT平扫(肺部、多层、重建)', price: 230, note: '' },
              { id: uid('item'), category: '彩超室', name: '彩色B超（肝、胆、胰、脾）', price: 105, note: '' }
            ]
          };
          const member = {
            id: uid('member'),
            name: '爸爸',
            gender: '男',
            age: 62,
            focus: '关注肺部、肝胆、血脂血糖'
          };
          this.packages.push(pkgA, pkgC);
          this.members.push(member);
          this.activeMemberId = member.id;
          this.compareIds = [pkgA.id, pkgC.id];
          ElementPlus.ElMessage.success('示例数据已添加。');
        }
      }
    });

    Object.entries(ElementPlusIconsVue).forEach(([key, component]) => {
      app.component(key, component);
    });
    app.use(ElementPlus, {
      locale: ELEMENT_PLUS_ZH_CN,
    });
    app.mount('#app');
    document.getElementById('app')?.removeAttribute('v-cloak');
