/**
 * QuestMaster - Ultimate Edition (Edit Games & Quests)
 */

// --- 1. Error Monitoring ---
window.onerror = function(msg, url, line) {
    console.error("Global Error:", msg, "at line", line);
    const toast = document.getElementById('error-toast');
    if (toast) {
        toast.textContent = "에러 발생: " + msg + " (" + line + "행)";
        toast.style.display = 'block';
        setTimeout(() => { toast.style.display = 'none'; }, 8000);
    }
    return false;
};

// --- 2. Configuration & State ---
let state = {
    user: null,
    quests: [],
    history: {},
    games: [],
    lastResetDate: null,
    activeGame: '전체',
    currentView: 'dashboard',
    calendarDate: new Date(),
    backups: [],
    appTitle: 'Quest Master',
    notes: ''
};

const DEFAULT_CONFIG = {
  apiKey: "AIzaSyB5ELr6AnfjicnHf_i_55t5xXJIYJmpOuo",
  authDomain: "dailyquest-303a0.firebaseapp.com",
  projectId: "dailyquest-303a0",
  storageBucket: "dailyquest-303a0.firebasestorage.app",
  messagingSenderId: "190718821428",
  appId: "1:190718821428:web:e34c2c072e10f404f67661"
};

function getStorageKey() {
    return state.user ? `QM_DATA_${state.user.uid}` : 'QM_DATA_GUEST';
}
function getBackupKey() {
    return state.user ? `QM_BACKUP_${state.user.uid}` : 'QM_BACKUP_GUEST';
}

let db = null;
let isInitialized = false;

// --- 3. Initialization ---
window.onload = async () => {
    render(); 
    initFirebase();
    setupEventListeners();
};

function initFirebase() {
    if (typeof firebase !== 'undefined') {
        const customConfig = localStorage.getItem('QM_CUSTOM_CONFIG');
        const config = customConfig ? JSON.parse(customConfig) : DEFAULT_CONFIG;
        
        if (!firebase.apps.length) firebase.initializeApp(config);
        db = firebase.firestore();
        
        firebase.auth().onAuthStateChanged(async (user) => {
            if (user) {
                state.user = user;
                loadLocal(); // 로컬 먼저 로드
                setupRealtimeSync(); // 클라우드 실시간 감시 시작 (여기서 최신 데이터면 즉시 덮어씀)
                checkResets(); 
            } else {
                if (unsubscribeSync) unsubscribeSync();
                state.user = null;
                state.quests = [];
                state.history = {};
                state.games = [];
                state.backups = [];
                state.calendarDate = new Date();
                state.currentView = 'dashboard';
            }
            render();
            isInitialized = true;
        });
    }
}

function login() {
    const provider = new firebase.auth.GoogleAuthProvider();
    firebase.auth().signInWithPopup(provider);
}

function logout() {
    firebase.auth().signOut().then(() => {
        state.user = null;
        render();
    });
}

function updateUserUI() {
    const section = document.getElementById('user-section');
    const headerSection = document.getElementById('header-user-section');

    const userHtml = state.user ? `
        <div style="display:flex; align-items:center; gap:10px; padding:10px; background:rgba(255,255,255,0.05); border-radius:12px;">
            <img src="${state.user.photoURL}" style="width: 32px; height: 32px; border-radius: 50%; border: 2px solid var(--primary);">
            <div style="flex: 1; font-size: 11px; overflow:hidden;">
                <div style="font-weight: 700; white-space:nowrap; text-overflow:ellipsis; overflow:hidden;">${state.user.displayName}</div>
                <button onclick="logout()" style="background:none; border:none; color:var(--text-dim); padding:0; cursor:pointer; font-size:10px;">Cloud Logout</button>
            </div>
        </div>
    ` : `
        <button class="btn btn-primary" onclick="login()" style="width: 100%; display:flex; align-items:center; justify-content:center; gap:8px;">
            <i data-lucide="cloud"></i> Cloud Sync
        </button>
    `;

    const headerUserHtml = state.user ? `
        <div class="header-avatar-wrapper" onclick="state.currentView='settings'; render();">
            <img src="${state.user.photoURL}" class="header-avatar-img">
            <div class="online-indicator"></div>
        </div>
    ` : `
        <button class="header-login-btn" onclick="login()">
            <i data-lucide="user"></i>
        </button>
    `;

    if (section) section.innerHTML = userHtml;
    if (headerSection) headerSection.innerHTML = headerUserHtml;
    
    // 모바일 하단바 아이콘 강제 생성
    if (window.lucide) {
        lucide.createIcons();
        // 렌더링 직후 아이콘이 누락되는 경우를 대비해 한 번 더 시도
        setTimeout(() => lucide.createIcons(), 50);
    }
}

let unsubscribeSync = null;
function setupRealtimeSync() {
    if (!state.user || !db) return;
    if (unsubscribeSync) unsubscribeSync();

    unsubscribeSync = db.collection('users').doc(state.user.uid).onSnapshot(doc => {
        if (doc.exists) {
            const cloud = doc.data();
            // 클라우드 데이터가 내 로컬보다 최신인 경우에만 자동 업데이트
            if ((cloud.updatedAt || 0) > (state.updatedAt || 0)) {
                console.log("Cloud update detected. Syncing silently...");
                const { user, calendarDate, backups, ...toSync } = cloud;
                state = { 
                    ...state, 
                    ...toSync,
                    backups: cloud.backups || state.backups 
                };
                
                // 클라우드 데이터를 받자마자 즉시 전수 조사(청소) 실시
                const cleaned = syncQuestsToHistoryFromDate();
                
                // 만약 청소된 내용이 있다면 서버에도 즉시 반영하여 '부활' 방지
                if (cleaned) {
                    console.log("History cleaned. Syncing back to server...");
                    save(true); // 동기화 액션으로 저장하여 알림 방지
                }
                
                // 로컬 스토리지 업데이트
                localStorage.setItem(getStorageKey(), JSON.stringify(toSync));
                localStorage.setItem(getBackupKey(), JSON.stringify(state.backups));
                
                render();
                const syncTime = new Date(cloud.updatedAt).toLocaleTimeString('ko-KR');
                showToast(`클라우드 최신 데이터 동기화 (${syncTime})`, "info");
            }
        }
    }, err => {
        console.warn("Real-time sync restricted.");
    });
}

async function syncCloud() {
    // 기존 syncCloud는 setupRealtimeSync가 대신하므로 비워두거나 초기 1회용으로 사용
    setupRealtimeSync();
}

async function saveCloud() {
    if (!state.user || !db) return;
    try {
        const { user, calendarDate, ...toSave } = state;
        // saveCloud는 현재 state에 기록된 updatedAt을 그대로 서버에 보냅니다. (Date.now() 사용 금지)
        await db.collection('users').doc(state.user.uid).set(toSave, { merge: true });
    } catch (e) { }
}

// --- 5. Core Logic ---
function save(isSyncAction = false) {
    // 로그인 여부와 관계없이 로컬 저장은 수행하여 알림창이 뜨게 합니다.
    
    // 사용자가 직접 수정하거나 리셋이 발생한 경우에만 시간을 새로 찍습니다.
    if (!isSyncAction) {
        state.updatedAt = Date.now();
        const saveTime = new Date(state.updatedAt).toLocaleTimeString('ko-KR');
        showToast(`저장 완료 (${saveTime})`, "info");
    }

    const { calendarDate, backups, ...toSave } = state;
    localStorage.setItem(getStorageKey(), JSON.stringify(toSave));
    localStorage.setItem(getBackupKey(), JSON.stringify(state.backups));
    saveCloud();
}

function loadLocal() {
    const saved = localStorage.getItem(getStorageKey());
    if (saved) {
        try { 
            const parsed = JSON.parse(saved);
            state = { ...state, ...parsed }; 
            state.calendarDate = new Date(); 
            state.currentView = 'dashboard';
        } catch (e) { }
    }
    const savedBackups = localStorage.getItem(getBackupKey());
    if (savedBackups) {
        try { state.backups = JSON.parse(savedBackups); } catch (e) { }
    }
    // 로드 후 즉시 전체 히스토리 정화(청소) 실시
    syncQuestsToHistoryFromDate();
}

function saveLocal() { 
    try {
        localStorage.setItem(getStorageKey(), JSON.stringify(state)); 
    } catch (e) { }
}

function getTodayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function updateHistoryToday() {
    const today = getTodayStr();
    
    // 오늘 히스토리가 없으면 기본 생성
    if (!state.history[today]) {
        const applicable = state.quests.filter(q => isQuestActiveOnDate(q, today));
        state.history[today] = { 
            quests: applicable.map(q => ({ 
                id: q.id, title: q.title, game: q.game, 
                completed: q.completed // 마스터 상태에서 가져옴
            })), 
            percent: 0 
        };
    }
    
    syncQuestsToHistoryFromDate(today);
}

/**
 * 특정 날짜부터의 모든 히스토리에 현재 활성화된 숙제들을 동기화합니다.
 * (과거 날짜로 숙제를 추가했을 때 기존 히스토리 스냅샷에 반영하기 위함)
 */
function syncQuestsToHistoryFromDate(startDateStr = null) {
    let hasChanged = false;
    Object.keys(state.history).forEach(dateStr => {
        if (!startDateStr || dateStr >= startDateStr) {
            const h = state.history[dateStr];
            const oldLen = h.quests.length;
            
            const applicable = state.quests.filter(q => isQuestActiveOnDate(q, dateStr));
            
            applicable.forEach(q => {
                const exists = h.quests.find(hq => hq.id === q.id);
                if (!exists) {
                    h.quests.push({ 
                        id: q.id, title: q.title, game: q.game, 
                        completed: isCompletedInCycle(q, dateStr) 
                    });
                    hasChanged = true;
                } else {
                    if (exists.title !== q.title || exists.game !== q.game) {
                        exists.title = q.title;
                        exists.game = q.game;
                        hasChanged = true;
                    }
                    const comp = isCompletedInCycle(q, dateStr);
                    if (exists.completed !== comp) {
                        exists.completed = comp;
                        hasChanged = true;
                    }
                }
            });
            
            h.quests = h.quests.filter(hq => {
                const mq = state.quests.find(x => x.id === hq.id);
                const keep = mq && isQuestActiveOnDate(mq, dateStr);
                if (!keep) hasChanged = true;
                return keep;
            });

            if (h.quests.length === 0) {
                delete state.history[dateStr];
                hasChanged = true;
            } else {
                const newPercent = calculatePercent(h.quests);
                if (h.percent !== newPercent) {
                    h.percent = newPercent;
                    hasChanged = true;
                }
            }
        }
    });
    return hasChanged;
}

function isQuestActiveOnDate(q, dateStr) {
    // 날짜 형식을 안전하게 문자열로 변환 (객체나 타임스탬프 대응)
    let createdAt = q.createdAt;
    if (createdAt && typeof createdAt !== 'string') {
        try {
            const d = createdAt.toDate ? createdAt.toDate() : new Date(createdAt);
            createdAt = d.toISOString().split('T')[0];
        } catch(e) { createdAt = getTodayStr(); }
    }
    if (!createdAt) createdAt = getTodayStr();

    if (q.type === 'once') {
        return createdAt === dateStr;
    }
    return createdAt <= dateStr;
}

function calculatePercent(quests) {
    if (!quests || quests.length === 0) return 0;
    const done = quests.filter(q => q.completed).length;
    return Math.round((done / quests.length) * 100);
}

function checkResets() {
    const now = new Date();
    let last = state.lastResetDate ? new Date(state.lastResetDate) : null;
    
    // 만약 마지막 리셋 기록이 없거나 너무 오래전(30일 이상)이면 
    // 성능을 위해 최근 시점(어제 오전 6시)부터만 리셋을 체크하도록 함
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    if (!last || last < thirtyDaysAgo) {
        last = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 어제로 설정
    }

    // 마지막 리셋 체크 시점부터 현재까지의 모든 '새벽 6시' 시점을 조사
    let checkDate = new Date(last);
    checkDate.setHours(6, 0, 0, 0);
    if (last >= checkDate) checkDate.setDate(checkDate.getDate() + 1);

    const todayReset = new Date(now);
    todayReset.setHours(6, 0, 0, 0);
    if (now < todayReset) todayReset.setDate(todayReset.getDate() - 1);

    let resetCount = 0;
    while (checkDate <= now) {
        state.quests.forEach(q => {
            if (shouldReset(q, checkDate)) {
                q.completed = false;
                delete q.completedAt;
                resetCount++;
            }
        });
        checkDate.setDate(checkDate.getDate() + 1);
    }

    if (resetCount > 0 || last < todayReset) {
        updateHistoryToday();
        state.lastResetDate = now.toISOString();
        save();
        if (resetCount > 0) {
            showToast(`${resetCount}개의 숙제가 리셋되었습니다!`, "info");
        }
    }
}

function showToast(msg, type = "error") {
    const toast = document.getElementById('error-toast');
    if (toast) {
        console.log("Toast Displaying:", msg); 
        toast.textContent = msg;
        toast.style.background = type === "info" ? "rgba(59, 130, 246, 0.98)" : "rgba(239, 68, 68, 0.98)";
        
        toast.classList.add('show');
        setTimeout(() => {
            toast.classList.remove('show');
        }, 3000);
    } else {
        // 백업용 (만약 요소가 없으면 alert이라도 띄움)
        console.log("Toast:", msg);
    }
}

function shouldReset(q, resetDate) {
    if (q.type === 'once') return false;
    if (q.type === 'daily') return true;
    if (q.type === 'weekly') return resetDate.getDay() === 1;
    if (q.type === 'biweekly') {
        const start = q.createdAt ? new Date(q.createdAt) : new Date(0);
        const diffWeeks = Math.floor((resetDate - start) / (7 * 24 * 60 * 60 * 1000));
        return resetDate.getDay() === 1 && (diffWeeks % 2 === 0);
    }
    if (q.type === 'interval') {
        const start = q.createdAt ? new Date(q.createdAt) : new Date(0);
        const diffDays = Math.floor((resetDate - start) / (24 * 60 * 60 * 1000));
        return diffDays % (parseInt(q.interval) || 1) === 0;
    }
    return false;
}

function syncStatusAcrossHistory(q, baseDate, forcedState = null) {
    try {
        const start = q.createdAt ? new Date(q.createdAt) : new Date(0);
        start.setHours(0,0,0,0);
        const base = new Date(baseDate);
        
        let targetState = forcedState;
        if (targetState === null) targetState = q.completed;

        let cycleDates = [];
        
        if (q.type === 'weekly' || q.type === 'biweekly') {
            const days = q.type === 'weekly' ? 7 : 14;
            const diff = Math.round((base - start) / (24 * 60 * 60 * 1000));
            const sDay = (start.getDay() === 0 ? 6 : start.getDay() - 1);
            const cycleStartOffset = Math.floor((diff + sDay) / days) * days - sDay;
            for (let i = 0; i < days; i++) {
                const d = new Date(start);
                d.setDate(d.getDate() + cycleStartOffset + i);
                cycleDates.push(d.toISOString().split('T')[0]);
            }
        } else if (q.type === 'interval') {
            const interval = parseInt(q.interval) || 1;
            const diff = Math.round((base - start) / (24 * 60 * 60 * 1000));
            const cycleStartOffset = Math.floor(diff / interval) * interval;
            for (let i = 0; i < interval; i++) {
                const d = new Date(start);
                d.setDate(d.getDate() + cycleStartOffset + i);
                cycleDates.push(d.toISOString().split('T')[0]);
            }
        } else {
            cycleDates.push(baseDate);
        }

        cycleDates.forEach(dateStr => {
            // 히스토리가 없으면 새로 생성
            if (!state.history[dateStr]) {
                const activeOnDate = state.quests.filter(mq => isQuestActiveOnDate(mq, dateStr));
                state.history[dateStr] = { 
                    quests: activeOnDate.map(mq => ({ 
                        id: mq.id, title: mq.title, game: mq.game, 
                        completed: mq.id === q.id ? targetState : isCompletedInCycle(mq, dateStr)
                    })), 
                    percent: 0 
                };
            } else {
                const hq = state.history[dateStr].quests.find(x => x.id === q.id);
                if (hq) hq.completed = targetState;
                else if (isQuestActiveOnDate(q, dateStr)) {
                    state.history[dateStr].quests.push({ 
                        id: q.id, title: q.title, game: q.game, 
                        completed: targetState 
                    });
                }
            }
            state.history[dateStr].percent = calculatePercent(state.history[dateStr].quests);
        });
    } catch (e) {
        console.error("Sync Error:", e);
    }
}

function isSameCycle(q, d1, d2) {
    if (q.type === 'daily' || q.type === 'once') return d1 === d2;
    
    const date1 = new Date(d1); date1.setHours(0,0,0,0);
    const date2 = new Date(d2); date2.setHours(0,0,0,0);
    const start = q.createdAt ? new Date(q.createdAt) : new Date(0); start.setHours(0,0,0,0);

    if (q.type === 'weekly') return isSameWeek(date1, date2);

    if (q.type === 'biweekly') {
        const diff1 = Math.round((date1 - start) / (24 * 60 * 60 * 1000));
        const diff2 = Math.round((date2 - start) / (24 * 60 * 60 * 1000));
        const sDay = (start.getDay() === 0 ? 6 : start.getDay() - 1);
        return Math.floor((diff1 + sDay) / 14) === Math.floor((diff2 + sDay) / 14);
    }

    if (q.type === 'interval') {
        const interval = parseInt(q.interval) || 1;
        const diff1 = Math.round((date1 - start) / (24 * 60 * 60 * 1000));
        const diff2 = Math.round((date2 - start) / (24 * 60 * 60 * 1000));
        return Math.floor(diff1 / interval) === Math.floor(diff2 / interval);
    }
    return false;
}

function isCompletedInCycle(q, dateStr) {
    // 해당 날짜의 히스토리가 이미 있다면 그 기록을 우선함
    const h = state.history[dateStr];
    if (h) {
        const hq = h.quests.find(x => x.id === q.id);
        if (hq) return hq.completed;
    }
    
    // 기록이 없는 경우 마스터 상태와 주기가 일치하는지 확인
    if (!q.completedAt) return false;
    return isSameCycle(q, dateStr, q.completedAt);
}

function isSameWeek(d1, d2) {
    const w1 = new Date(d1); w1.setHours(0,0,0,0);
    const w2 = new Date(d2); w2.setHours(0,0,0,0);
    const diff1 = (w1.getDay() === 0 ? 6 : w1.getDay() - 1);
    const diff2 = (w2.getDay() === 0 ? 6 : w2.getDay() - 1);
    w1.setDate(w1.getDate() - diff1);
    w2.setDate(w2.getDate() - diff2);
    return w1.toDateString() === w2.toDateString();
}

// --- 6. Rendering ---
function render() {
    try {
        const logo = document.querySelector('.logo-text');
        if (logo) logo.textContent = state.appTitle || 'Quest Master';
        document.title = state.appTitle || 'Quest Master';

        const views = ['dashboard', 'calendar', 'games', 'notes', 'settings'];
        views.forEach(v => {
            const btn = document.getElementById(`nav-${v}`);
            const mobileBtn = document.querySelector(`.mobile-bottom-nav [data-action="nav-${v}"]`);
            const view = document.getElementById(`${v}-view`);
            
            if (btn) btn.classList.toggle('active', state.currentView === v);
            if (mobileBtn) mobileBtn.classList.toggle('active', state.currentView === v);
            if (view) view.classList.toggle('hidden', state.currentView !== v);
        });

        if (state.currentView === 'dashboard') renderDashboard();
        else if (state.currentView === 'calendar') renderCalendar();
        else if (state.currentView === 'games') renderGames();
        else if (state.currentView === 'notes') renderNotes();
        else if (state.currentView === 'settings') renderSettings();

        updateStats();
        updateUserUI();
        if (window.lucide) lucide.createIcons();
    } catch (e) { }
}

function renderDashboard() {
    updateDate();
    const daily = document.getElementById('daily-quest-list');
    const weekly = document.getElementById('weekly-quest-list');
    const filter = document.getElementById('game-filter');
    if (!daily || !weekly || !filter) return;
    
    filter.innerHTML = `<option value="전체">모든 게임</option>` + 
                      state.games.map(g => `<option value="${g}" ${g === state.activeGame ? 'selected' : ''}>${g}</option>`).join('');

    daily.innerHTML = ''; weekly.innerHTML = '';
    const todayStr = getTodayStr();
    
    const filteredQuests = state.quests.filter(q => {
        if (state.activeGame !== '전체' && q.game !== state.activeGame) return false;
        return isQuestActiveOnDate(q, todayStr);
    });

    filteredQuests.forEach(q => {
        const dday = getDaysUntilReset(q);
        const isUrgent = !q.completed && dday >= 0 && dday <= 1;

        const card = document.createElement('div');
        card.className = `quest-card glass ${q.completed ? 'completed' : ''}`;
        card.innerHTML = `
            <div class="checkbox-wrapper" data-action="toggle" data-id="${q.id}">
                ${q.completed ? '<i data-lucide="check"></i>' : ''}
            </div>
            <div class="quest-content" data-action="edit-quest" data-id="${q.id}">
                <div class="quest-title">${q.title} ${isUrgent ? '<span class="urgent-tag">🔥 빨리!</span>' : ''}</div>
                <div class="quest-meta">${q.game} | ${getRepeatText(q)} ${q.type === 'once' ? `(${formatDate(q.createdAt)} 등록)` : `<span class="reset-dday">[${dday === 0 ? '내일 리셋' : `D-${dday}`}]</span>`}</div>
            </div>
            <div class="quest-actions">
                <button class="edit-quest-btn" data-action="edit-quest" data-id="${q.id}"><i data-lucide="edit-3"></i></button>
                <button class="delete-quest-btn" data-action="delete" data-id="${q.id}"><i data-lucide="trash-2"></i></button>
            </div>
        `;
        if (q.type === 'daily' || q.type === 'interval' || q.type === 'once') daily.appendChild(card);
        else weekly.appendChild(card);
    });
    if (filteredQuests.length === 0) daily.innerHTML = '<p class="empty-msg">기록이 없습니다.</p>';
}

function renderNotes() {
    const textarea = document.getElementById('notes-textarea');
    if (textarea) {
        textarea.value = state.notes || '';
        
        // 중복 리스너 방지를 위해 한 번만 등록
        if (!textarea.dataset.listener) {
            textarea.addEventListener('input', (e) => {
                state.notes = e.target.value;
                const status = document.getElementById('note-status');
                if (status) status.textContent = '저장 중...';
                
                // 디바운싱: 500ms 후 저장
                clearTimeout(textarea.timer);
                textarea.timer = setTimeout(() => {
                    save();
                    if (status) status.textContent = '자동 저장됨';
                }, 500);
            });
            textarea.dataset.listener = "true";
        }
    }
}

function renderSettings() {
    const view = document.getElementById('settings-view');
    if (!view) return;
    
    view.innerHTML = `
        <div class="section-header"><h2>데이터 관리</h2></div>
        <main class="main-content">
            <header class="top-header">
                <div class="mobile-logo">
                    <i data-lucide="layout-grid"></i>
                    <span class="logo-text">Quest Master</span>
                </div>
                <div class="header-user-section-settings">
                    <!-- Mobile Login UI Settings View -->
                </div>
            </header>
        <div class="settings-container">
            <!-- 일반 설정 -->
            <div class="settings-card">
                <h3><i data-lucide="settings-2"></i> 일반 설정</h3>
                <div class="flex-row" style="gap: 10px;">
                    <div style="flex: 1;">
                        <label style="font-size: 0.75rem; color: var(--text-dim); display: block; margin-bottom: 5px;">앱 이름</label>
                        <input type="text" id="input-app-title" class="quest-input" style="margin: 0; width: 100%;" value="${state.appTitle || 'Quest Master'}">
                    </div>
                    <button class="btn btn-primary" id="btn-save-title" style="margin-top: 20px;">적용</button>
                </div>
            </div>

            <!-- 백업 섹션 -->
            <div class="settings-card">
                <div class="backup-header">
                    <h3><i data-lucide="database"></i> 데이터 백업 (최대 10개)</h3>
                    <button class="btn btn-primary btn-sm" id="btn-backup-now">
                        <i data-lucide="plus"></i> 새로운 백업
                    </button>
                </div>
                <div class="backup-grid" style="margin-top: 1rem;">
                    ${state.backups.length === 0 ? '<p class="empty-msg">저장된 백업이 없습니다.</p>' : 
                        state.backups.map((b, idx) => `
                            <div class="backup-card">
                                <div class="backup-header">
                                    <div class="backup-name">${b.name || '이름 없음'}</div>
                                    <div style="display: flex; gap: 4px;">
                                        <button class="action-btn" data-action="edit-backup-name" data-idx="${idx}"><i data-lucide="edit-3"></i></button>
                                        <button class="action-btn" data-action="delete-backup" data-idx="${idx}"><i data-lucide="trash-2"></i></button>
                                    </div>
                                </div>
                                <div class="backup-meta">${b.date}</div>
                                <div class="backup-stats">
                                    <i data-lucide="check-square" style="width: 12px; vertical-align: middle"></i> 숙제 ${b.quests.length}개 
                                    <span style="margin: 0 5px; opacity: 0.3">|</span>
                                    <i data-lucide="calendar" style="width: 12px; vertical-align: middle"></i> 기록 ${Object.keys(b.history).length}일분
                                </div>
                                <button class="btn btn-primary btn-sm" data-action="load-backup" data-idx="${idx}" style="width: 100%; margin-top: 5px;">복구하기</button>
                            </div>
                        `).join('')
                    }
                </div>
            </div>

            <!-- Firebase 설정 변경 (고급) -->
            <div class="settings-card">
                <div class="stat-header">
                    <h3><i data-lucide="database"></i> 클라우드 서버 설정 (Firebase)</h3>
                    <span class="badge ${localStorage.getItem('QM_CUSTOM_CONFIG') ? 'badge-primary' : 'badge-dim'}" style="font-size: 0.7rem;">
                        ${localStorage.getItem('QM_CUSTOM_CONFIG') ? '커스텀 서버' : '기본 서버'}
                    </span>
                </div>
                <div style="background: rgba(0,0,0,0.2); padding: 10px; border-radius: 8px; margin-bottom: 1rem; font-size: 0.8rem;">
                    <div style="color: var(--text-dim); margin-bottom: 4px;">현재 연결된 프로젝트:</div>
                    <code style="color: var(--primary); font-weight: 700;">${firebase.app().options.projectId}</code>
                </div>
                <p style="font-size: 0.8rem; color: var(--text-dim); margin-bottom: 1rem;">본인의 Firebase 프로젝트 키를 입력하여 서버를 교체할 수 있습니다.</p>
                <textarea id="input-fb-config" class="quest-input" style="width: 100%; height: 100px; font-family: monospace; font-size: 0.75rem;" placeholder='{"apiKey": "...", "authDomain": "...", ...}'></textarea>
                <div style="display: flex; gap: 8px; margin-top: 10px;">
                    <button class="btn btn-primary btn-sm" id="btn-save-fb" style="flex: 1;">설정 저장 및 재시작</button>
                    <button class="btn btn-danger btn-sm" id="btn-reset-fb">초기화</button>
                </div>
            </div>

            <!-- 위험 구역 -->
            <div class="settings-card danger-zone">
                <h3 style="color: #ef4444;"><i data-lucide="alert-circle"></i> 위험 구역</h3>
                <div class="flex-row" style="justify-content: space-between; align-items: center;">
                    <div>
                        <div style="font-weight: 600; font-size: 0.9rem;">전체 데이터 초기화</div>
                        <div style="font-size: 0.8rem; color: var(--text-dim);">모든 숙제와 과거 기록을 삭제합니다. 이 작업은 되돌릴 수 없습니다.</div>
                    </div>
                    <button class="btn btn-danger" id="btn-clear-all">초기화 실행</button>
                </div>
            </div>
        </div>
    `;
    if (window.lucide) lucide.createIcons();
}

function renderGames() {
    const list = document.getElementById('game-list');
    if (!list) return;
    list.innerHTML = state.games.map(g => {
        const qCount = state.quests.filter(q => q.game === g).length;
        return `
            <div class="char-card glass">
                <div class="char-avatar">${g.charAt(0)}</div>
                <div class="char-name">${g}</div>
                <div class="char-count">숙제 ${qCount}개</div>
                <div style="display: flex; gap: 5px; margin-top: 10px;">
                   <button class="action-btn" data-action="edit-game" data-name="${g}"><i data-lucide="edit-3"></i></button>
                   <button class="action-btn" data-action="delete-game" data-name="${g}"><i data-lucide="x"></i></button>
                </div>
            </div>
        `;
    }).join('');
}

function getRepeatText(q) {
    if (q.type === 'once') return '반복 안함';
    if (q.type === 'daily') return '매일';
    if (q.type === 'weekly') return '매주';
    if (q.type === 'biweekly') return '격주';
    if (q.type === 'interval') return `${q.interval}일마다`;
    return '일반';
}

function formatDate(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return '';
    const parts = dateStr.split('-');
    if (parts.length < 3) return dateStr;
    return `${parseInt(parts[1])}월 ${parseInt(parts[2])}일`;
}

function getDaysUntilReset(q) {
    if (q.type === 'once') return -1;
    const now = new Date();
    const today6am = new Date(now);
    today6am.setHours(6, 0, 0, 0);
    if (now < today6am) today6am.setDate(today6am.getDate() - 1);
    if (q.type === 'daily') return 0;
    if (q.type === 'weekly') {
        let next = new Date(today6am);
        next.setDate(next.getDate() + (8 - next.getDay()) % 7 || 7);
        return Math.ceil((next - now) / (1000 * 60 * 60 * 24)) - 1;
    }
    if (q.type === 'biweekly') {
        const start = q.createdAt ? new Date(q.createdAt) : new Date();
        if (isNaN(start.getTime())) return -1;
        
        let next = new Date(today6am);
        let safetyCounter = 0;
        while (safetyCounter < 100) {
            next.setDate(next.getDate() + (8 - next.getDay()) % 7 || 7);
            const diffWeeks = Math.floor((next - start) / (7 * 24 * 60 * 60 * 1000));
            if (diffWeeks % 2 === 0) break;
            safetyCounter++;
        }
        return Math.ceil((next - now) / (1000 * 60 * 60 * 24)) - 1;
    }
    if (q.type === 'interval') {
        const start = q.createdAt ? new Date(q.createdAt) : new Date(0);
        const interval = parseInt(q.interval) || 1;
        const diffDays = Math.floor((today6am - start) / (24 * 60 * 60 * 1000));
        const remaining = interval - (diffDays % interval);
        return remaining - 1;
    }
    return -1;
}

function renderCalendar() {
    const grid = document.getElementById('calendar-grid');
    const title = document.getElementById('calendar-month-year');
    if (!grid || !title) return;
    
    const year = state.calendarDate.getFullYear();
    const month = state.calendarDate.getMonth();
    title.textContent = `${year}년 ${month + 1}월`;
    const firstDay = new Date(year, month, 1).getDay();
    const lastDate = new Date(year, month + 1, 0).getDate();
    grid.innerHTML = '';
    for (let i = 0; i < firstDay; i++) grid.appendChild(document.createElement('div')).className = 'day-cell empty';
    const todayStr = getTodayStr();
    for (let d = 1; d <= lastDate; d++) {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const history = state.history[dateStr];
        const activeQuests = state.quests.filter(q => isQuestActiveOnDate(q, dateStr));
        
        const cell = document.createElement('div');
        cell.className = 'day-cell';
        if (dateStr === todayStr) cell.classList.add('today');
        
        let percent = 0;
        let displayQuests = [];

        if (history) {
            percent = history.percent;
            displayQuests = history.quests;
        } else if (activeQuests.length > 0) {
            // 기록은 없지만 숙제가 있는 경우 가상 진척도 계산
            const done = activeQuests.filter(q => isCompletedInCycle(q, dateStr)).length;
            percent = Math.round((done / activeQuests.length) * 100);
            displayQuests = activeQuests;
        }

        if (displayQuests.length > 0) {
            cell.classList.add('has-data');
            if (percent === 100) cell.classList.add('perfect');
            else if (percent > 0) cell.classList.add('in-progress');
            else cell.classList.add('has-data-pending');
        }
        
        cell.innerHTML = `<span>${d}</span>`;
        cell.onclick = () => showHistoryDetail(dateStr);
        grid.appendChild(cell);
    }
}

function showHistoryDetail(dateStr) {
    const detail = document.getElementById('history-detail');
    const list = document.getElementById('history-list');
    const dateTitle = document.getElementById('history-date');
    const percentBadge = document.getElementById('history-percent');
    if (!detail || !list) return;

    detail.classList.remove('hidden');
    dateTitle.textContent = `${dateStr} 기록`;
    
    if (!state.history[dateStr]) {
        const applicable = state.quests.filter(q => isQuestActiveOnDate(q, dateStr));
        state.history[dateStr] = { 
            quests: applicable.map(q => ({ id: q.id, title: q.title, game: q.game, completed: isCompletedInCycle(q, dateStr) })), 
            percent: 0 
        };
    }
    
    const h = state.history[dateStr];
    h.percent = calculatePercent(h.quests);
    const addBtnHtml = `<button class="btn btn-primary" style="padding: 0.4rem 0.8rem; font-size: 0.8rem; margin-right: 10px;" onclick="renderForm('${dateStr}'); document.getElementById('modal-container').classList.remove('hidden');">추가</button>`;
    percentBadge.innerHTML = `${addBtnHtml} <span style="margin-left: 10px">${h.percent}% 완료</span>`;
    list.innerHTML = h.quests.map((q, idx) => `
        <div class="history-item">
            <div class="hist-info"><span>[${q.game}] ${q.title}</span></div>
            <div class="hist-actions">
                <span class="hist-status ${q.completed ? 'done' : 'undone'}" 
                      style="cursor: pointer;" data-action="toggle-hist" data-date="${dateStr}" data-idx="${idx}">
                    ${q.completed ? '완료' : '미완료'}
                </span>
                <button class="action-btn" data-action="edit-hist" data-date="${dateStr}" data-idx="${idx}"><i data-lucide="edit-3"></i></button>
                <button class="action-btn" data-action="delete-hist" data-date="${dateStr}" data-idx="${idx}"><i data-lucide="trash-2"></i></button>
            </div>
        </div>
    `).join('');
    if (window.lucide) lucide.createIcons();
}

function updateStats() {
    const todayStr = getTodayStr();
    let visible = state.quests.filter(q => {
        if (state.activeGame !== '전체' && q.game !== state.activeGame) return false;
        return isQuestActiveOnDate(q, todayStr);
    });

    const total = visible.length;
    const done = visible.filter(q => q.completed).length;
    const perc = calculatePercent(visible);
    
    const fill = document.getElementById('stat-fill');
    const percText = document.getElementById('stat-percent');
    const remains = document.getElementById('stat-remains');

    if (fill) fill.style.width = perc + '%';
    if (percText) percText.textContent = perc + '%';
    if (remains) remains.textContent = total - done;
}

function updateDate() {
    const el = document.getElementById('current-date');
    if (el) el.textContent = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
}

function updateUserUI() {
    const container = document.getElementById('user-section');
    if (!container) return;
    if (state.user) {
        container.innerHTML = `
            <div class="user-card glass">
                <img src="${state.user.photoURL}" alt="" class="avatar">
                <div class="user-info"><div class="user-name">${state.user.displayName}</div><div class="user-status">Cloud Sync</div></div>
                <div class="user-actions"><button class="action-btn" id="btn-sync"><i data-lucide="refresh-cw"></i></button><button class="logout-btn" id="btn-logout"><i data-lucide="log-out"></i></button></div>
            </div>
        `;
    } else {
        container.innerHTML = `<button class="login-btn" id="btn-login"><i data-lucide="log-in"></i><span>Google 로그인</span></button>`;
    }
}

// --- 7. Event Handling ---
function setupEventListeners() {
    document.addEventListener('click', async (e) => {
        const target = e.target.closest('[data-action], [id]');
        if (!target) return;
        const action = target.dataset.action;
        const id = target.dataset.id;

        if (action && action.startsWith('nav-')) {
            state.currentView = action.replace('nav-', '');
            render();
            window.scrollTo(0,0);
        }

        if (action === 'toggle') {
            const q = state.quests.find(x => x.id == id);
            if (q) { 
                const today = getTodayStr();
                const newState = !q.completed;
                
                // 마스터 상태 즉시 변경
                q.completed = newState; 
                if (newState) q.completedAt = today;
                else delete q.completedAt;
                
                // 모든 관련 히스토리 일괄 갱신
                syncStatusAcrossHistory(q, today);
                
                render(); 
                save(); 
            }
        }
        if (action === 'toggle-hist') {
            const dateStr = target.dataset.date;
            const idx = target.dataset.idx;
            const h = state.history[dateStr];
            if (h && h.quests[idx]) {
                const qH = h.quests[idx];
                const newState = !qH.completed;
                qH.completed = newState;
                
                const mQ = state.quests.find(q => q.id === qH.id);
                if (mQ) {
                    const today = getTodayStr();
                    if (isSameCycle(mQ, dateStr, today)) {
                        mQ.completed = newState;
                        if (newState) mQ.completedAt = dateStr;
                        else delete mQ.completedAt;
                    }
                    // 해당 주기의 모든 히스토리 동기화 (강제 상태값 전달)
                    syncStatusAcrossHistory(mQ, dateStr, newState);
                }

                h.percent = calculatePercent(h.quests);
                render(); 
                showHistoryDetail(dateStr); 
                save();
            }
        }
        if (action === 'delete') {
            const q = state.quests.find(x => x.id == id);
            if (!q) return;
            const same = state.quests.filter(x => x.title === q.title);
            let ids = [q.id];
            if (same.length > 1) {
                if (confirm(`'${q.title}' ${same.length}개를 모두 영구 삭제할까요?`)) ids = same.map(x => x.id);
                else if (!confirm("이 하나만 영구 삭제할까요?")) return;
            } else if (!confirm("완전히 삭제하시겠습니까?")) return;

            state.quests = state.quests.filter(x => !ids.includes(x.id));
            Object.keys(state.history).forEach(d => {
                const h = state.history[d];
                h.quests = h.quests.filter(hq => !ids.includes(hq.id));
                if (h.quests.length === 0) delete state.history[d];
                else h.percent = calculatePercent(h.quests);
            });
            render(); save();
        }
        if (action === 'delete-hist') {
            const dateStr = target.dataset.date;
            const idx = target.dataset.idx;
            const qH = state.history[dateStr].quests[idx];
            if (!qH) return;
            const choice = confirm(`'${qH.title}' 삭제 옵션:\n\n[확인]: 전체 기록에서 일괄 삭제\n[취소]: 이 날짜만 삭제`);
            if (choice) {
                const ids = state.quests.filter(x => x.title === qH.title).map(x => x.id);
                if (ids.length === 0) ids.push(qH.id);
                state.quests = state.quests.filter(x => !ids.includes(x.id));
                Object.keys(state.history).forEach(d => {
                    const h = state.history[d];
                    h.quests = h.quests.filter(x => x.title !== qH.title && !ids.includes(x.id));
                    if (h.quests.length === 0) delete state.history[d];
                    else h.percent = calculatePercent(h.quests);
                });
                document.getElementById('history-detail').classList.add('hidden');
            } else {
                state.history[dateStr].quests.splice(idx, 1);
                if (state.history[dateStr].quests.length === 0) {
                    delete state.history[dateStr];
                    document.getElementById('history-detail').classList.add('hidden');
                } else {
                    state.history[dateStr].percent = calculatePercent(state.history[dateStr].quests);
                    showHistoryDetail(dateStr);
                }
            }
            save(); renderCalendar();
        }
        if (action === 'edit-hist') {
            const dateStr = target.dataset.date;
            const idx = target.dataset.idx;
            const q = state.history[dateStr].quests[idx];
            const t = prompt("이름 수정:", q.title);
            if (t) { q.title = t; showHistoryDetail(dateStr); save(); }
        }
        if (action === 'edit-game') {
            const old = target.dataset.name;
            const n = prompt("게임 이름 변경:", old);
            if (n && n !== old) {
                state.games = state.games.map(g => g === old ? n : g);
                state.quests.forEach(q => { if (q.game === old) q.game = n; });
                Object.values(state.history).forEach(h => h.quests.forEach(q => { if (q.game === old) q.game = n; }));
                if (state.activeGame === old) state.activeGame = n;
                render(); save();
            }
        }
        if (action === 'edit-quest') {
            const q = state.quests.find(x => x.id == id);
            if (q) { document.getElementById('modal-container').classList.remove('hidden'); renderForm(null, q); }
        }
        if (action === 'delete-game') {
            const name = target.dataset.name;
            if (confirm(`'${name}' 게임과 연관된 모든 숙제를 삭제하시겠습니까?`)) {
                state.quests = state.quests.filter(q => q.game !== name);
                state.games = state.games.filter(g => g !== name);
                render(); save();
            }
        }
        if (target.id === 'btn-clear-all') {
            if (confirm("⚠️ 경고: 모든 데이터(숙제, 기록)가 영구 삭제됩니다. 계속하시겠습니까?") && 
                confirm("정말로 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.")) {
                state.quests = [];
                state.history = {};
                state.games = [];
                render(); save();
                showToast("모든 데이터가 초기화되었습니다.", "info");
            }
        }
        if (target.id === 'btn-backup-now') {
            if (state.backups.length >= 10) {
                if (!confirm("백업이 10개를 초과했습니다. 가장 오래된 백업을 지우고 새로 만들까요?")) return;
                state.backups.shift();
            }
            const name = prompt("백업 이름을 입력하세요:", `백업_${new Date().toLocaleDateString()}`);
            if (name === null) return;

            const snap = {
                name: name || `백업_${new Date().toLocaleDateString()}`,
                date: new Date().toLocaleString('ko-KR'),
                quests: JSON.parse(JSON.stringify(state.quests)),
                history: JSON.parse(JSON.stringify(state.history)),
                games: JSON.parse(JSON.stringify(state.games))
            };
            state.backups.push(snap);
            save(); render();
            showToast("현재 상태가 백업되었습니다.", "info");
        }
        if (action === 'edit-backup-name') {
            const idx = target.dataset.idx;
            const b = state.backups[idx];
            const newName = prompt("백업 이름 수정:", b.name || "");
            if (newName !== null) {
                b.name = newName;
                save(); render();
            }
        }
        if (action === 'load-backup') {
            const idx = target.dataset.idx;
            const b = state.backups[idx];
            if (confirm(`[${b.date}] 백업으로 복구할까요?\n현재 데이터는 사라집니다.`)) {
                state.quests = b.quests;
                state.history = b.history;
                state.games = b.games;
                render(); save();
                showToast("데이터가 복구되었습니다.", "info");
            }
        }
        if (target.id === 'btn-save-title') {
            const input = document.getElementById('input-app-title');
            if (input && input.value.trim()) {
                state.appTitle = input.value.trim();
                render(); save();
                showToast("앱 이름이 변경되었습니다.", "info");
            }
        }
        if (target.closest('.logo')) {
            const n = prompt("새로운 앱 이름을 입력하세요:", state.appTitle);
            if (n) {
                state.appTitle = n;
                render(); save();
            }
        }
        if (action === 'delete-backup') {
            const idx = target.dataset.idx;
            if (confirm("이 백업을 삭제하시겠습니까?")) {
                state.backups.splice(idx, 1);
                save(); render();
            }
        }
        if (target.id === 'btn-export-json') {
            const data = {
                quests: state.quests,
                history: state.history,
                games: state.games,
                appTitle: state.appTitle,
                backups: state.backups
            };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `quest_master_backup_${new Date().toLocaleDateString()}.json`;
            a.click();
            URL.revokeObjectURL(url);
            showToast("데이터 파일이 다운로드되었습니다.", "info");
        }
        if (target.id === 'btn-save-fb') {
            const val = document.getElementById('input-fb-config').value;
            try {
                JSON.parse(val);
                localStorage.setItem('QM_CUSTOM_CONFIG', val);
                alert("설정이 저장되었습니다. 앱을 재시작합니다.");
                location.reload();
            } catch (e) { alert("올바른 JSON 형식이 아닙니다."); }
        }
        if (target.id === 'btn-reset-fb') {
            if (confirm("Firebase 설정을 기본값으로 초기화할까요?")) {
                localStorage.removeItem('QM_CUSTOM_CONFIG');
                location.reload();
            }
        }
        if (target.id === 'btn-import-trigger') {
            document.getElementById('input-import-json').click();
        }
        if (target.id === 'input-import-json') {
            target.onchange = (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (event) => {
                    try {
                        const imported = JSON.parse(event.target.result);
                        if (confirm("파일에서 데이터를 불러올까요? 현재 데이터는 덮어씌워집니다.")) {
                            state = { ...state, ...imported };
                            render(); save();
                            showToast("데이터를 성공적으로 불러왔습니다.", "info");
                        }
                    } catch (err) {
                        showToast("유효하지 않은 파일 형식입니다.");
                    }
                };
                reader.readAsText(file);
            };
        }

    // --- 최우선 순위: 탭 전환 처리 ---
    const navItem = target.closest('.nav-item');
    if (navItem) {
        const id = navItem.id || navItem.dataset.action;
        if (id === 'nav-dashboard') state.currentView = 'dashboard';
        else if (id === 'nav-calendar') state.currentView = 'calendar';
        else if (id === 'nav-games') state.currentView = 'games';
        else if (id === 'nav-notes') state.currentView = 'notes';
        else if (id === 'nav-settings') state.currentView = 'settings';
        render();
        return; 
    }
        if (target.id === 'btn-add-game') {
            const name = prompt("새 게임 이름:");
            if (name && !state.games.includes(name)) { state.games.push(name); render(); save(); }
        }
        if (target.id === 'prev-month') { state.calendarDate.setMonth(state.calendarDate.getMonth() - 1); render(); }
        if (target.id === 'next-month') { state.calendarDate.setMonth(state.calendarDate.getMonth() + 1); render(); }
        if (target.id === 'btn-login') { if (typeof firebase !== 'undefined') firebase.auth().signInWithPopup(new firebase.auth.GoogleAuthProvider()); }
        if (target.id === 'btn-logout') { if (typeof firebase !== 'undefined') firebase.auth().signOut(); }
        if (target.id === 'btn-sync') await syncCloud();
        if (target.id === 'add-quest-btn') { document.getElementById('modal-container').classList.remove('hidden'); renderForm(); }
        if (target.id === 'close-modal') document.getElementById('modal-container').classList.add('hidden');
    });

    document.addEventListener('change', (e) => {
        if (e.target.id === 'game-filter') { state.activeGame = e.target.value; render(); }
    });
}

function renderForm(initialDate, editQuest = null) {
    const titleEl = document.getElementById('modal-title');
    if (titleEl) titleEl.textContent = editQuest ? "숙제 수정" : "숙제 추가";
    const defaultDate = editQuest ? editQuest.createdAt : (initialDate || getTodayStr());
    const body = document.querySelector('.modal-body');
    if (!body) return;
    
    body.innerHTML = `
        <form id="quest-form">
            <div class="form-group"><label>날짜 선택</label><input type="date" id="in-date" value="${defaultDate}"></div>
            <div class="form-group"><label>숙제 내용</label><input type="text" id="in-title" value="${editQuest ? editQuest.title : ''}" placeholder="예: 숙제 이름" required></div>
            <div class="form-group"><label>게임 선택</label><select id="in-game">${state.games.map(g => `<option value="${g}" ${editQuest && editQuest.game === g ? 'selected' : ''}>${g}</option>`).join('')}<option value="_new">+ 추가</option></select></div>
            <div class="form-group"><label>반복 주기</label>
                <select id="in-type" onchange="document.getElementById('interval-input').style.display = this.value === 'interval' ? 'block' : 'none'">
                    <option value="once" ${editQuest && editQuest.type === 'once' ? 'selected' : ''}>반복 안함 (일회성)</option>
                    <option value="daily" ${editQuest && editQuest.type === 'daily' ? 'selected' : ''}>매일</option>
                    <option value="weekly" ${editQuest && editQuest.type === 'weekly' ? 'selected' : ''}>매주</option>
                    <option value="biweekly" ${editQuest && editQuest.type === 'biweekly' ? 'selected' : ''}>격주</option>
                    <option value="interval" ${editQuest && editQuest.type === 'interval' ? 'selected' : ''}>N일마다</option>
                </select>
            </div>
            <div class="form-group" id="interval-input" style="${editQuest && editQuest.type === 'interval' ? 'display: block;' : 'display: none;'}">
                <label>반복 일수 (N)</label><input type="number" id="in-interval" value="${editQuest ? editQuest.interval : 2}" min="1">
            </div>
            <button type="submit" class="btn btn-primary" style="width: 100%; margin-top: 1rem;">${editQuest ? '수정 완료' : '숙제 등록'}</button>
        </form>
    `;

    document.getElementById('quest-form').onsubmit = (e) => {
        e.preventDefault();
        const selectedDate = document.getElementById('in-date').value;
        let game = document.getElementById('in-game').value;
        if (game === '_new') {
            const name = prompt("새 게임 이름:");
            if (name) { state.games.push(name); game = name; } else return;
        }
        const formData = { title: document.getElementById('in-title').value, game: game, type: document.getElementById('in-type').value, interval: document.getElementById('in-interval').value, createdAt: selectedDate };
        if (editQuest) { 
            Object.assign(state.quests.find(x => x.id === editQuest.id), formData); 
            syncQuestsToHistoryFromDate(selectedDate);
        }
        else {
            const newQuest = { id: Date.now(), ...formData, completed: false };
            state.quests.push(newQuest);
            syncQuestsToHistoryFromDate(selectedDate);
        }
        document.getElementById('modal-container').classList.add('hidden');
        render(); save();
    };
}


