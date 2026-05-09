/**
 * QuestMaster - Ultimate Edition (Edit Games & Quests)
 */

// --- 1. Error Monitoring ---
window.onerror = function(msg, url, line) {
    console.error("Global Error:", msg, "at line", line);
    showToast("에러 발생: " + msg + " (" + line + "행)", "error");
    return false;
};

// --- 2. Configuration & State ---
let state = {
    user: null,
    quests: [],
    history: {},
    games: [],
    activeGame: '',
    lastResetDate: null,
    currentView: 'dashboard',
    calendarDate: new Date(),
    backups: [],
    appTitle: 'Quest Master',
    notes: '',
    logs: [],
    screenshots: [],
    viewDate: getTodayStr(),
    gameIcons: {},
    todos: []
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
function getAutoBackupKey() {
    return state.user ? `QM_AUTO_BACKUP_${state.user.uid}` : 'QM_AUTO_BACKUP_GUEST';
}

let db = null;
let isInitialized = false;

// --- 3. Initialization ---
window.onload = async () => {
    initFirebase();
    render(); 
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
    if (confirm("로그아웃 하시겠습니까?")) {
        firebase.auth().signOut().then(() => {
            state.user = null;
            render();
        });
    }
}


function renderUserSection() {
    const userSection = document.getElementById('user-section');
    const mobileUserSection = document.getElementById('header-user-section');
    const fabUserText = document.getElementById('fab-user-text');
    const fabUserAction = document.getElementById('fab-user-action');
    if (!userSection) return;

    if (state.user) {
        const userCardHtml = `
            <div class="user-card-premium glass">
                <img src="${state.user.photoURL || 'https://via.placeholder.com/40'}" alt="profile" class="user-avatar">
                <div class="user-info-main">
                    <div class="user-name-row">
                        <span class="user-name">${state.user.displayName || '사용자'}</span>
                        <div class="sync-status">
                            <span class="status-dot"></span>
                            <span class="status-text">Cloud Sync</span>
                        </div>
                    </div>
                </div>
                <div class="user-actions-mini">
                    <button class="action-btn-sm" onclick="syncData()" title="데이터 동기화">
                        <i data-lucide="refresh-cw"></i>
                    </button>
                    <button class="action-btn-sm logout" onclick="logout()" title="로그아웃">
                        <i data-lucide="log-out"></i>
                    </button>
                </div>
            </div>
        `;
        const mobileUserHtml = `
            <div class="header-avatar-wrapper" onclick="logout()">
                <img src="${state.user.photoURL || 'https://via.placeholder.com/40'}" alt="profile" class="header-avatar-img">
                <div class="online-indicator"></div>
            </div>
        `;
        userSection.innerHTML = userCardHtml;
        if (mobileUserSection) mobileUserSection.innerHTML = mobileUserHtml;

        if (fabUserText && fabUserAction) {
            fabUserText.textContent = '로그아웃';
            fabUserAction.onclick = () => { logout(); toggleFab(); };
            const icon = fabUserAction.querySelector('i');
            if (icon) icon.setAttribute('data-lucide', 'log-out');
        }
    } else {
        const loginBtnHtml = `
            <button class="btn-login-full glass" onclick="login()">
                <i data-lucide="log-in"></i>
                <span>로그인하여 시작하기</span>
            </button>
        `;
        const mobileLoginHtml = `
            <button class="header-login-btn" onclick="login()">
                <i data-lucide="user"></i>
            </button>
        `;
        userSection.innerHTML = loginBtnHtml;
        if (mobileUserSection) mobileUserSection.innerHTML = mobileLoginHtml;

        if (fabUserText && fabUserAction) {
            fabUserText.textContent = '로그인';
            fabUserAction.onclick = () => { login(); toggleFab(); };
            const icon = fabUserAction.querySelector('i');
            if (icon) icon.setAttribute('data-lucide', 'user');
        }
    }
    if (window.lucide) lucide.createIcons();
}

let unsubscribeSync = null;
function setupRealtimeSync() {
    if (!state.user || !db) return;
    if (unsubscribeSync) unsubscribeSync();

    unsubscribeSync = db.collection('users').doc(state.user.uid).onSnapshot(doc => {
        if (doc.exists) {
            const cloud = doc.data();
            if ((cloud.updatedAt || 0) > (state.updatedAt || 0)) {
                console.log("Cloud update detected. Syncing...");
                const { user, calendarDate, backups, logs, ...toSync } = cloud;
                state = { 
                    ...state, 
                    ...toSync
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
        // 백업과 로그를 제외한 모든 데이터(압축된 스크린샷 포함)를 메인 문서에 저장
        const { user, calendarDate, backups, logs, ...toSave } = state;
        await db.collection('users').doc(state.user.uid).set(toSave, { merge: true });
    } catch (e) { 
        console.warn("Cloud save failed:", e);
        if (e.code === 'permission-denied') {
            showToast("클라우드 저장 권한이 없습니다.", "error");
        } else if (e.message.includes("limit")) {
            showToast("데이터 용량이 너무 큽니다. 스크린샷을 줄여주세요.", "warning");
        }
    }
}

// 개별 업로드 함수는 이제 사용하지 않음 (메인 문서에 통합)
async function uploadScreenshotCloud(s) { }
async function deleteScreenshotCloud(id) { }

// --- 5. Core Logic ---
function save(isSyncAction = false) {
    // 사용자가 직접 수정하거나 리셋이 발생한 경우에만 시간을 새로 찍습니다.
    if (!isSyncAction) {
        state.updatedAt = Date.now();
        const saveTime = new Date(state.updatedAt).toLocaleTimeString('ko-KR');
        showToast(`저장 완료 (${saveTime})`, "info");
    }

    // 모든 중요 데이터를 포함하여 저장
    const { calendarDate, backups, user, ...toSave } = state;
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
            // 앱 실행 시에는 항상 오늘 날짜를 우선으로 보여줌
            state.viewDate = getTodayStr();
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

    // '전체' 탭 제거 및 활성 탭 정리
    state.games = (state.games || []).filter(g => g !== '전체');
    if (!state.activeGame || state.activeGame === '전체') {
        state.activeGame = state.games.length > 0 ? state.games[0] : '';
    }

    // 자동 백업 체크
    setTimeout(checkAutoBackup, 2000); // 실행 2초 후 체크
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

    // 종료일 체크: endDate가 있으면 그 날짜 이후엔 비활성화
    if (q.endDate && dateStr > q.endDate) return false;

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
    const todayStr = getTodayStr();
    const resetHour = state.settings ? (state.settings.resetHour || 0) : 0;

    // 만약 자정이 지나 날짜가 바뀌었다면 뷰 날짜도 자동 갱신
    if (state.lastResetDate !== todayStr && now.getHours() >= resetHour) {
        state.viewDate = todayStr;
        state.lastResetDate = todayStr;
        
        state.quests.forEach(q => {
            q.completed = false;
        });
        
        render();
        save();
    }

    let last = state.lastResetDate ? new Date(state.lastResetDate) : null;
    
    // 만약 마지막 리셋 기록이 없거나 너무 오래전(30일 이상)이면 
    // 성능을 위해 최근 시점(어제 오전 6시)부터만 리셋을 체크하도록 함
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    if (!last || last < thirtyDaysAgo) {
        last = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 어제로 설정
    }

    // 마지막 리셋 체크 시점부터 현재까지의 모든 '새벽 6시' 시점을 조사
    let checkDate = new Date(last);
    checkDate.setHours(resetHour, 0, 0, 0);
    if (last >= checkDate) checkDate.setDate(checkDate.getDate() + 1);

    const todayReset = new Date(now);
    todayReset.setHours(resetHour, 0, 0, 0);
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
        // 모든 로고 텍스트 업데이트 (사이드바, 모바일 헤더 등 전체)
        const logos = document.querySelectorAll('.logo-text');
        logos.forEach(logo => {
            logo.textContent = state.appTitle || 'Quest Master';
        });
        document.title = state.appTitle || 'Quest Master';

        const views = ['dashboard', 'calendar', 'games', 'notes', 'todo', 'gallery', 'log', 'settings'];
        const viewNames = {
            'dashboard': '숙제',
            'calendar': '캘린더',
            'games': '탭 관리',
            'notes': '노트',
            'todo': '일회용 숙제',
            'gallery': '갤러리',
            'log': '히스토리 로그',
            'settings': '데이터 및 로컬 저장'
        };

        views.forEach(v => {
            const btn = document.getElementById(`nav-${v}`);
            const mobileBtn = document.querySelector(`.mobile-bottom-nav [data-action="nav-${v}"]`);
            const view = document.getElementById(`${v}-view`);
            
            if (btn) {
                btn.classList.toggle('active', state.currentView === v);
                const span = btn.querySelector('span');
                if (span) span.textContent = viewNames[v];
            }
            if (mobileBtn) mobileBtn.classList.toggle('active', state.currentView === v);
            if (view) view.classList.toggle('hidden', state.currentView !== v);
        });

        if (state.currentView === 'dashboard') renderDashboard();
        else if (state.currentView === 'calendar') renderCalendar();
        else if (state.currentView === 'games') renderGames();
        else if (state.currentView === 'notes') renderNotes();
        else if (state.currentView === 'todo') renderTodo();
        else if (state.currentView === 'gallery') renderGallery();
        else if (state.currentView === 'log') renderLog();
        else if (state.currentView === 'settings') renderSettings();

        // 대시보드 전용 헤더 액션 및 동적 헤더 노출 제어
        const headerActions = document.querySelector('.header-actions');
        const dynamicHeader = document.querySelector('.dashboard-dynamic-header');
        const isDashboard = state.currentView === 'dashboard';

        if (headerActions) headerActions.style.display = isDashboard ? 'flex' : 'none';
        if (dynamicHeader) dynamicHeader.classList.toggle('show', isDashboard);

        updateStats();
        renderUserSection();
        
        // 앱 로고 아이콘 반영
        const logoIconArea = document.querySelector('.logo i');
        if (logoIconArea && state.appIcon) {
            const logoImg = document.createElement('img');
            logoImg.src = state.appIcon;
            logoImg.className = 'app-logo-img';
            logoIconArea.replaceWith(logoImg);
        } else if (state.appIcon) {
            const existingImg = document.querySelector('.app-logo-img');
            if (existingImg) existingImg.src = state.appIcon;
        }

        if (window.lucide) lucide.createIcons();
}

window.triggerGameIconUpload = function(gameName) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (event) => {
                if (!state.gameIcons) state.gameIcons = {};
                state.gameIcons[gameName] = event.target.result;
                addLog('edit', `${gameName} 탭 아이콘 변경됨`);
                save(); render();
            };
            reader.readAsDataURL(file);
        }
    };
    input.click();
};

window.toggleFab = function() {
    const container = document.getElementById('mobile-fab-container');
    if (container) {
        container.classList.toggle('active');
    }
};


function renderCalendar() {
    const grid = document.getElementById('calendar-grid');
    const monthYear = document.getElementById('calendar-month-year');
    if (!grid || !monthYear) return;

    const year = state.calendarDate.getFullYear();
    const month = state.calendarDate.getMonth();
    monthYear.textContent = `${year}년 ${month + 1}월`;

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayStr = getTodayStr();

    grid.innerHTML = '';
    for (let i = 0; i < firstDay; i++) {
        const cell = document.createElement('div');
        cell.className = 'day-cell empty';
        grid.appendChild(cell);
    }
    
    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const history = state.history[dateStr];
        const activeQuests = state.quests.filter(q => isQuestActiveOnDate(q, dateStr));
        const isToday = dateStr === todayStr;
        
        const cell = document.createElement('div');
        cell.className = 'day-cell';
        if (isToday) cell.classList.add('today');
        
        let percent = 0;
        let displayQuests = [];

        if (history) {
            percent = history.percent;
            displayQuests = history.quests;
        } else if (activeQuests.length > 0) {
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

    // 통계 그래프 렌더링
    renderStats();
    if (window.lucide) lucide.createIcons();
}

function renderStats() {
    const chart = document.getElementById('bar-chart');
    const labels = document.getElementById('bar-chart-labels');
    if (!chart || !labels) return;

    // 최근 30일 날짜 배열 생성
    const days = [];
    for (let i = 29; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        days.push(d.toISOString().split('T')[0]);
    }

    // 통계 계산
    const percentages = days.map(d => (state.history[d] ? state.history[d].percent : 0));
    const daysWithData = percentages.filter(p => p > 0);
    const avg = daysWithData.length > 0
        ? Math.round(daysWithData.reduce((a, b) => a + b, 0) / daysWithData.length)
        : 0;
    const best = daysWithData.length > 0 ? Math.max(...daysWithData) : 0;

    // 연속 달성 계산 (오늘부터 거꾸로)
    let streak = 0;
    for (let i = days.length - 1; i >= 0; i--) {
        if (percentages[i] >= 100) streak++;
        else break;
    }

    // 요약 카드 업데이트
    const avgEl = document.getElementById('stat-avg');
    const streakEl = document.getElementById('stat-streak');
    const bestEl = document.getElementById('stat-best');
    if (avgEl) avgEl.textContent = `${avg}%`;
    if (streakEl) streakEl.textContent = `${streak}일`;
    if (bestEl) bestEl.textContent = `${best}%`;

    // 막대 그래프 렌더링
    chart.innerHTML = days.map((dateStr, i) => {
        const pct = percentages[i];
        const height = Math.max(pct, 2); // 최소 2px 높이
        let barColor = 'var(--primary)';
        if (pct >= 100) barColor = '#10b981'; // 초록
        else if (pct >= 50) barColor = '#3b82f6'; // 파랑
        else if (pct > 0) barColor = '#f59e0b'; // 노랑
        else barColor = 'rgba(255,255,255,0.08)'; // 투명

        return `<div class="bar-item" title="${dateStr}: ${pct}%">
            <div class="bar-fill" style="height:${height}%; background:${barColor};" data-pct="${pct}"></div>
        </div>`;
    }).join('');

    // 날짜 레이블 (7일 간격)
    labels.innerHTML = days.map((dateStr, i) => {
        if (i % 7 === 0) {
            const parts = dateStr.split('-');
            return `<span class="bar-label">${parseInt(parts[1])}/${parseInt(parts[2])}</span>`;
        }
        return `<span class="bar-label-empty"></span>`;
    }).join('');
}

function renderLog() {
    const list = document.getElementById('log-list');
    if (!list) return;

    if (!state.logs || state.logs.length === 0) {
        list.innerHTML = '<p class="empty-msg" style="padding: 2rem;">아직 시스템 기록이 없습니다.</p>';
        return;
    }

    // 최신 순으로 정렬 (id 역순)
    const sortedLogs = [...state.logs].sort((a, b) => b.id - a.id);
    list.innerHTML = sortedLogs.map(log => {
        const d = new Date(log.id);
        const dateStr = d.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' });
        const timeStr = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        
        let icon = 'info';
        let color = 'var(--text-dim)';
        if (log.action === 'add') { icon = 'plus-circle'; color = '#10b981'; } // Green
        else if (log.action === 'edit') { icon = 'edit-3'; color = '#3b82f6'; } // Blue
        else if (log.action === 'delete') { icon = 'trash-2'; color = '#ef4444'; } // Red
        else if (log.action === 'complete') { icon = 'check-circle'; color = '#f59e0b'; } // Yellow

        return `
            <div class="log-item">
                <div class="log-icon" style="color: ${color};"><i data-lucide="${icon}"></i></div>
                <div class="log-content">
                    <div class="log-detail">${log.detail}</div>
                    <div class="log-time">${dateStr} ${timeStr}</div>
                </div>
            </div>
        `;
    }).join('');
}

function renderTodo() {
    const list = document.getElementById('todo-list');
    if (!list) return;
    
    if (!state.todos || state.todos.length === 0) {
        list.innerHTML = '<p class="empty-msg" style="padding: 2rem;">등록된 일회용 숙제가 없습니다.</p>';
        return;
    }

    list.innerHTML = state.todos.map(t => {
        const dateObj = t.createdAt ? new Date(t.createdAt) : null;
        const dateStr = dateObj ? `${dateObj.getFullYear()}.${String(dateObj.getMonth() + 1).padStart(2, '0')}.${String(dateObj.getDate()).padStart(2, '0')} ${String(dateObj.getHours()).padStart(2, '0')}:${String(dateObj.getMinutes()).padStart(2, '0')}` : '';
        
        return `
            <div class="todo-item glass ${t.completed ? 'completed' : ''}">
                <div class="checkbox-wrapper" onclick="toggleTodo(${t.id})">
                    ${t.completed ? '<i data-lucide="check"></i>' : ''}
                </div>
                <div class="todo-content">
                    <div class="todo-title">${t.title}</div>
                    ${dateStr ? `<div class="todo-date">${dateStr} 추가됨</div>` : ''}
                </div>
                <div class="todo-actions">
                    <button class="delete-quest-btn" onclick="deleteTodo(${t.id})" style="display: flex; align-items: center; justify-content: center;">
                        <i data-lucide="trash-2" style="width: 18px; height: 18px;"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');
    if (window.lucide) lucide.createIcons();
}

window.toggleTodo = function(id) {
    const t = state.todos.find(x => x.id === id);
    if (t) {
        t.completed = !t.completed;
        addLog('complete', `일회용 숙제 상태 변경: ${t.title} (${t.completed ? '완료' : '미완료'})`);
        save(); renderTodo();
    }
}

window.deleteTodo = function(id) {
    const t = state.todos.find(x => x.id === id);
    if (t) {
        addLog('delete', `일회용 숙제 삭제됨: ${t.title}`);
        state.todos = state.todos.filter(x => x.id !== id);
        save(); renderTodo();
    }
}

function renderGallery() {
    const list = document.getElementById('gallery-list');
    const input = document.getElementById('input-screenshot');
    if (!list || !input) return;

    // 이벤트 리스너 중복 방지
    if (!input.dataset.listener) {
        input.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file) {
                // 용량 제한을 위해 이미지 압축
                try {
                    const compressed = await compressImage(file);
                    if (!state.screenshots) state.screenshots = [];
                    const newShot = { id: Date.now(), data: compressed };
                    state.screenshots.push(newShot);
                    addLog('info', '갤러리에 새 스크린샷이 추가되었습니다.');
                    save(); 
                    uploadScreenshotCloud(newShot); // 클라우드 개별 업로드
                    renderGallery();
                } catch (err) {
                    showToast("이미지 처리 중 오류가 발생했습니다.");
                }
            }
        });
        input.dataset.listener = "true";
    }

    if (!state.screenshots || state.screenshots.length === 0) {
        list.innerHTML = '<p class="empty-msg" style="padding: 2rem;">저장된 스크린샷이 없습니다.</p>';
        return;
    }

    list.innerHTML = state.screenshots.map(s => `
        <div class="gallery-item glass">
            <img src="${s.data}" alt="Screenshot" onclick="openLightbox('${s.data}')">
            <button class="gallery-delete" onclick="deleteScreenshot(${s.id})">
                <i data-lucide="trash-2"></i>
            </button>
        </div>
    `).join('');
    if (window.lucide) lucide.createIcons();
}

function deleteScreenshot(id) {
    if (confirm("이 스크린샷을 삭제하시겠습니까?")) {
        state.screenshots = state.screenshots.filter(s => s.id !== id);
        addLog('delete', '스크린샷이 삭제되었습니다.');
        save();
        deleteScreenshotCloud(id); // 클라우드에서도 삭제
        renderGallery();
    }
}

// 이미지 압축 유틸리티
async function compressImage(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (event) => {
            const img = new Image();
            img.src = event.target.result;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;
                
                // 최대 너비 1200px로 제한
                const MAX_WIDTH = 1200;
                if (width > MAX_WIDTH) {
                    height *= MAX_WIDTH / width;
                    width = MAX_WIDTH;
                }
                
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                
                // JPEG 품질 0.7로 압축 (용량 최적화)
                const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
                resolve(dataUrl);
            };
            img.onerror = reject;
        };
        reader.onerror = reject;
    });
}

function renderNotes() {
    const listContainer = document.getElementById('notes-list');
    const emptyState = document.getElementById('editor-empty-state');
    const activeState = document.getElementById('editor-active-state');
    const textarea = document.getElementById('notes-textarea');
    const titleInput = document.getElementById('note-title-input');
    const saveStatus = document.getElementById('note-save-status');

    if (!listContainer) return;

    // 데이터 호환성: 기존 문자열 형태의 notes를 배열로 변환
    if (typeof state.notes === 'string') {
        const oldContent = state.notes;
        state.notes = [{
            id: Date.now(),
            title: '이전 메모',
            content: oldContent,
            date: new Date().toISOString()
        }];
        save();
    }
    if (!state.notes) state.notes = [];

    // 리스트 렌더링
    listContainer.innerHTML = state.notes.length === 0 
        ? '<p class="empty-msg-sm">노트가 없습니다.</p>' 
        : state.notes.map(note => `
            <div class="note-item ${state.activeNoteId === note.id ? 'active' : ''}" onclick="selectNote(${note.id})">
                <div class="note-item-title">${note.title || '제목 없음'}</div>
                <div class="note-item-date">${new Date(note.date).toLocaleDateString()}</div>
            </div>
        `).join('');

    // 에디터 상태 제어
    const activeNote = state.notes.find(n => n.id === state.activeNoteId);
    if (activeNote) {
        emptyState.classList.add('hidden');
        activeState.classList.remove('hidden');
        textarea.value = activeNote.content || '';
        titleInput.value = activeNote.title || '';

        // 리스너 등록 (한 번만)
        if (!textarea.dataset.listener) {
            textarea.addEventListener('input', (e) => {
                const note = state.notes.find(n => n.id === state.activeNoteId);
                if (note) {
                    note.content = e.target.value;
                    note.date = new Date().toISOString();
                    saveStatus.textContent = '저장 중...';
                    clearTimeout(textarea.timer);
                    textarea.timer = setTimeout(() => {
                        save();
                        addLog('note', `메모 업데이트됨: ${note.title || '제목 없음'}`);
                        saveStatus.textContent = '자동 저장됨';
                        renderNotes();
                    }, 800);
                }
            });
            titleInput.addEventListener('input', (e) => {
                const note = state.notes.find(n => n.id === state.activeNoteId);
                if (note) {
                    note.title = e.target.value;
                    note.date = new Date().toISOString();
                    save();
                    renderNotes();
                }
            });
            textarea.dataset.listener = "true";
        }
    } else {
        emptyState.classList.remove('hidden');
        activeState.classList.add('hidden');
    }
    if (window.lucide) lucide.createIcons();
}

window.addNote = function() {
    const newNote = {
        id: Date.now(),
        title: '',
        content: '',
        date: new Date().toISOString()
    };
    state.notes.unshift(newNote);
    state.activeNoteId = newNote.id;
    addLog('note', '새 메모가 추가되었습니다.');
    save();
    renderNotes();
}

window.selectNote = function(id) {
    state.activeNoteId = id;
    renderNotes();
}

window.deleteActiveNote = function() {
    if (confirm("이 노트를 삭제하시겠습니까?")) {
        state.notes = state.notes.filter(n => n.id !== state.activeNoteId);
        state.activeNoteId = null;
        addLog('note', '메모가 삭제되었습니다.');
        save();
        renderNotes();
    }
}

function renderSettings() {
    const view = document.getElementById('settings-view');
    if (!view) return;
    
    view.innerHTML = `
        <div class="section-header"><h2>데이터 및 로컬 저장</h2></div>
        <div class="settings-container">
            <!-- 로컬 저장소 관리 -->
            <div class="settings-card" style="border-left: 4px solid var(--primary);">
                <div class="backup-header">
                    <h3><i data-lucide="database"></i> 로컬 저장소 관리</h3>
                    <button class="btn btn-primary btn-sm" onclick="save()">
                        <i data-lucide="save"></i> 즉시 저장
                    </button>
                </div>
                <div id="local-storage-info" style="font-size: 0.85rem; color: var(--text-dim); margin: 1rem 0; line-height: 1.6; background: rgba(255,255,255,0.03); padding: 12px; border-radius: 8px;">
                    로딩 중...
                </div>
                <div style="display: flex; gap: 8px;">
                    <button class="btn btn-primary" id="btn-export-json" style="flex: 1">
                        <i data-lucide="upload"></i> 파일로 내보내기
                    </button>
                    <button class="btn btn-primary" id="btn-import-trigger" style="flex: 1">
                        <i data-lucide="download"></i> 파일에서 불러오기
                    </button>
                </div>
            </div>

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

            <!-- 서버 및 아이콘 설정 -->
            <div class="settings-card">
                <div class="stat-header">
                    <h3><i data-lucide="image"></i> 사이트 아이콘 설정</h3>
                </div>
                <div class="flex-row" style="gap: 15px; align-items: center; margin-bottom: 1.5rem;">
                    <div class="site-icon-preview glass">
                        <img src="${state.appIcon || 'icon.png'}" id="current-site-icon" style="width: 50px; height: 50px; border-radius: 10px; object-fit: cover;">
                    </div>
                    <button class="btn btn-primary btn-sm" onclick="document.getElementById('input-site-icon').click()">
                        <i data-lucide="upload"></i> 아이콘 변경
                    </button>
                    <input type="file" id="input-site-icon" hidden accept="image/*" onchange="updateSiteIcon(this)">
                </div>
                
                <div class="stat-header">
                    <h3><i data-lucide="server"></i> 클라우드 서버 설정 (Firebase)</h3>
                    <span class="badge ${localStorage.getItem('QM_CUSTOM_CONFIG') ? 'badge-primary' : 'badge-dim'}" style="font-size: 0.7rem;">
                        ${localStorage.getItem('QM_CUSTOM_CONFIG') ? '커스텀 서버' : '기본 서버'}
                    </span>
                </div>
                <div style="background: rgba(0,0,0,0.2); padding: 12px; border-radius: 12px; margin-bottom: 1rem; font-size: 0.85rem;">
                    <div style="color: var(--text-dim); margin-bottom: 6px;">현재 연결된 프로젝트:</div>
                    <code style="color: var(--primary); font-weight: 700;">${(firebase.apps.length > 0) ? firebase.app().options.projectId : '연결 중...'}</code>
                </div>
                <p style="font-size: 0.85rem; color: var(--text-dim); margin-bottom: 1rem;">본인의 Firebase 프로젝트 키를 입력하여 서버를 교체할 수 있습니다.</p>
                <textarea id="input-fb-config" class="quest-input" style="width: 100%; height: 120px; font-family: monospace; font-size: 0.8rem; padding: 15px;" placeholder='{"apiKey": "...", "authDomain": "...", ...}'></textarea>
                <div style="display: flex; gap: 12px; margin-top: 20px;">
                    <button class="btn btn-primary btn-sm" id="btn-save-fb" style="flex: 1; padding: 12px;">설정 저장 및 재시작</button>
                    <button class="btn-reset-action btn-sm" id="btn-reset-fb" style="padding: 12px;"><i data-lucide="refresh-ccw"></i> 초기화</button>
                </div>
            </div>

            <!-- 위험 구역 -->
            <div class="settings-card danger-zone">
                <h3 style="color: #f43f5e; margin-bottom: 0.8rem;"><i data-lucide="alert-circle"></i> 위험 구역</h3>
                <div style="display: flex; flex-direction: column; gap: 24px;">
                    <div>
                        <div style="font-weight: 700; font-size: 1.1rem; color: var(--text-bright); margin-bottom: 8px;">전체 데이터 초기화</div>
                        <div style="font-size: 0.9rem; color: var(--text-dim); line-height: 1.6; max-width: 500px;">
                            모든 숙제와 과거 기록을 삭제합니다. 이 작업은 되돌릴 수 없습니다. 
                            데이터를 초기화하기 전에 백업을 생성하는 것을 권장합니다.
                        </div>
                    </div>
                    <div style="margin-top: 10px;">
                        <button class="btn-reset-action" id="btn-clear-all" style="padding: 12px 24px; font-size: 1rem;">
                            <i data-lucide="trash-2"></i> 초기화 실행
                        </button>
                    </div>
                </div>
            </div>

            <!-- 자동 백업 복구 (비상용) -->
            <div class="settings-card" style="border-color: rgba(59, 130, 246, 0.2); background: rgba(59, 130, 246, 0.03);">
                <h3><i data-lucide="life-buoy"></i> 비상 자동 백업 복구</h3>
                <p style="font-size: 0.8rem; color: var(--text-dim); margin-bottom: 1rem;">시스템이 12시간마다 자동으로 생성한 백업입니다. 데이터 유실 시에만 사용하세요.</p>
                <div id="auto-backup-list" class="flex-row" style="gap: 10px; flex-wrap: wrap;">
                    <!-- 자동 백업 목록 동적 생성 -->
                </div>
            </div>
        </div>
    `;
    renderAutoBackupList();
    
    // 로컬 저장소 정보 업데이트
    const infoEl = document.getElementById('local-storage-info');
    if (infoEl) {
        const questCount = state.quests.length;
        const historyCount = Object.keys(state.history).length;
        const noteCount = (state.notes || []).length;
        const todoCount = (state.todos || []).length;
        const screenshotCount = (state.screenshots || []).length;
        const lastSave = state.updatedAt ? new Date(state.updatedAt).toLocaleString() : '기록 없음';
        
        // 대략적인 용량 계산 (UTF-16 기준 문자당 2바이트)
        const dataStr = JSON.stringify(state);
        const kb = Math.round((dataStr.length * 2) / 1024);
        
        infoEl.innerHTML = `
            <div>• 등록된 숙제: ${questCount}개</div>
            <div>• 히스토리 기록: ${historyCount}개</div>
            <div>• 메모/할 일: ${noteCount}/${todoCount}개</div>
            <div>• 스크린샷: ${screenshotCount}장</div>
            <div>• 현재 사용량: ~${kb} KB</div>
            <div style="margin-top:4px; color:var(--primary); font-weight:600;">마지막 저장: ${lastSave}</div>
        `;
    }
    
    if (window.lucide) lucide.createIcons();
}

function renderDashboard() {
    updateDate();
    renderMiniCalendarStrip(); // 주간 달력 스트립 렌더링
    const daily = document.getElementById('daily-quest-list');
    const weekly = document.getElementById('weekly-quest-list');
    const displayDate = document.getElementById('display-dashboard-date');
    const filter = document.getElementById('game-filter');
    if (!daily || !weekly) return;

    if (filter) {
        if (state.games.length === 0) {
            filter.innerHTML = '<option value="">등록된 탭 없음</option>';
        } else {
            filter.innerHTML = state.games.map(g => `<option value="${g}" ${g === state.activeGame ? 'selected' : ''}>${g}</option>`).join('');
        }
    }

    const targetDate = state.viewDate || getTodayStr();
    if (displayDate) displayDate.textContent = targetDate;

    // 해당 날짜에 활성화된 숙제 필터링
    const filteredQuests = state.quests.filter(q => {
        if (q.game !== state.activeGame) return false;
        return isQuestActiveOnDate(q, targetDate);
    });
    
    daily.innerHTML = '';
    weekly.innerHTML = '';

    filteredQuests.forEach(q => {
        const isDone = isCompletedInCycle(q, targetDate);
        const dday = getDaysUntilReset(q);
        
        const card = document.createElement('div');
        card.className = `quest-card glass ${isDone ? 'completed' : ''}`;
        
        let endInfo = '';
        if (q.endDate) {
            const diff = (new Date(q.endDate) - new Date(targetDate)) / (1000*60*60*24);
            if (diff <= 3 && diff >= 0) endInfo = `<span class="urgent-tag">종료 ${Math.ceil(diff)}일 전</span>`;
        }

        card.innerHTML = `
            <div class="drag-handle" draggable="true">
                <i data-lucide="grip-vertical"></i>
            </div>
            <div class="checkbox-wrapper" data-action="toggle" data-id="${q.id}">
                ${isDone ? '<i data-lucide="check"></i>' : ''}
            </div>
            <div class="quest-content" data-action="edit-quest" data-id="${q.id}">
                <div class="quest-title">${q.title}</div>
                <div class="quest-meta">${q.game} | ${getRepeatText(q)} ${q.type === 'once' ? `(${formatDate(q.createdAt)} 등록)` : `<span class="reset-dday">[D-${dday}]</span>`} ${endInfo}</div>
            </div>
            <div class="quest-actions">
                <button class="edit-quest-btn" data-action="edit-quest" data-id="${q.id}"><i data-lucide="edit-3"></i></button>
                <button class="delete-quest-btn" data-action="delete" data-id="${q.id}"><i data-lucide="trash-2"></i></button>
            </div>
        `;
        // 드래그 이벤트 바인딩
        card.setAttribute('draggable', 'true');
        card.setAttribute('data-id', q.id);
        card.addEventListener('dragstart', handleDragStart);
        card.addEventListener('dragover', handleDragOver);
        card.addEventListener('drop', handleDrop);
        card.addEventListener('dragend', handleDragEnd);

        if (q.type === 'daily' || q.type === 'interval' || q.type === 'once') daily.appendChild(card);
        else weekly.appendChild(card);
    });

    if (filteredQuests.length === 0) daily.innerHTML = '<p class="empty-msg">해당 날짜에 활성화된 숙제가 없습니다.</p>';
    if (window.lucide) lucide.createIcons();
}

function changeDashboardDate(offset) {
    const d = new Date(state.viewDate);
    d.setDate(d.getDate() + offset);
    state.viewDate = d.toISOString().split('T')[0];
    render();
}

function setDashboardDate(dateStr) {
    state.viewDate = dateStr;
    render();
}

function renderGames() {
    const list = document.getElementById('game-list');
    if (!list) return;
    list.innerHTML = state.games.map(g => {
        const qCount = state.quests.filter(q => q.game === g).length;
        const icon = state.gameIcons && state.gameIcons[g];
        return `
            <div class="char-card glass">
                <div class="char-avatar">
                    ${icon ? `<img src="${icon}" class="char-icon-img">` : g.charAt(0)}
                </div>
                <div class="char-name">${g}</div>
                <div class="char-count">숙제 ${qCount}개</div>
                <div style="display: flex; gap: 5px; margin-top: 10px;">
                   <label class="action-btn" title="아이콘 변경">
                       <i data-lucide="image"></i>
                       <input type="file" hidden accept="image/*" onchange="uploadGameIcon('${g}', this)">
                   </label>
                   <button class="action-btn" data-action="edit-game" data-name="${g}" title="이름 수정"><i data-lucide="edit-3"></i></button>
                   <button class="action-btn" data-action="delete-game" data-name="${g}" title="삭제"><i data-lucide="x"></i></button>
                </div>
            </div>
        `;
    }).join('');
    if (window.lucide) lucide.createIcons();
}

window.uploadGameIcon = function(gameName, input) {
    const file = input.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            if (!state.gameIcons) state.gameIcons = {};
            state.gameIcons[gameName] = e.target.result;
            save();
            renderGames();
        };
        reader.readAsDataURL(file);
    }
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
    const allDone = h.quests.length > 0 && h.quests.every(q => q.completed);

    dateTitle.textContent = dateStr;
    percentBadge.textContent = `${h.percent}%`;
    
    const actionsContainer = document.getElementById('history-actions-container');
    if (actionsContainer) {
        actionsContainer.innerHTML = `
            <button class="btn-hist-action" onclick="renderForm('${dateStr}'); document.getElementById('modal-container').classList.remove('hidden');" title="추가">
                <i data-lucide="plus"></i>
            </button>
            <button class="btn-hist-action ${allDone ? 'all-done' : ''}" onclick="completeAllOnDate('${dateStr}')" title="${allDone ? '완료 취소' : '모두 완료'}">
                <i data-lucide="${allDone ? 'rotate-ccw' : 'check-check'}"></i>
            </button>
        `;
    }
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

function completeAllOnDate(dateStr) {
    const h = state.history[dateStr];
    if (!h || !h.quests || h.quests.length === 0) return;
    const allDone = h.quests.every(q => q.completed);
    // 모두 완료면 모두 취소, 아니면 모두 완료
    h.quests.forEach(q => { q.completed = !allDone; });
    h.percent = calculatePercent(h.quests);
    // 마스터 퀘스트에도 반영
    if (dateStr === getTodayStr()) {
        h.quests.forEach(hq => {
            const mq = state.quests.find(q => q.id === hq.id);
            if (mq) {
                mq.completed = hq.completed;
                addLog('complete', `숙제 완료 상태 변경: [${mq.game}] ${mq.title}`);
            }
        });
    }
    save();
    showHistoryDetail(dateStr);
    renderCalendar();
    showToast(allDone ? '완료 취소되었습니다.' : '모두 완료되었습니다! 🎉', 'info');
}

function updateStats() {
    const todayStr = getTodayStr();
    const targetDate = state.viewDate || todayStr;
    
    // 현재 필터와 날짜에 맞는 숙제들 추출
    let visible = state.quests.filter(q => {
        if (q.game !== state.activeGame) return false;
        return isQuestActiveOnDate(q, targetDate);
    });

    const total = visible.length;
    // 해당 날짜의 완료 여부를 정확히 체크 (isCompletedInCycle 활용)
    const done = visible.filter(q => isCompletedInCycle(q, targetDate)).length;
    const perc = total > 0 ? Math.round((done / total) * 100) : 0;
    
    const fill = document.getElementById('stat-fill');
    const percText = document.getElementById('stat-percent');

    if (fill) fill.style.width = perc + '%';
    if (percText) percText.textContent = perc + '%';
}

// 주간 달력 스트립 렌더링 함수 (타임라인 스타일)
function renderMiniCalendarStrip() {
    const container = document.getElementById('mini-calendar-strip');
    if (!container) return;

    const targetDate = new Date(state.viewDate || getTodayStr());
    const todayStr = getTodayStr();
    const activeDateStr = state.viewDate || todayStr;
    
    container.innerHTML = '';

    for (let i = -3; i <= 3; i++) {
        const d = new Date(targetDate);
        d.setDate(d.getDate() + i);
        const dateStr = d.toISOString().split('T')[0];
        const isToday = dateStr === todayStr;
        const isActive = dateStr === activeDateStr;
        
        const activeQuests = state.quests.filter(q => isQuestActiveOnDate(q, dateStr));
        const done = activeQuests.filter(q => isCompletedInCycle(q, dateStr)).length;
        const hasData = activeQuests.length > 0;
        const isPerfect = hasData && done === activeQuests.length;
        
        const item = document.createElement('div');
        item.className = `timeline-item ${isActive ? 'active' : ''} ${isToday ? 'is-today' : ''} ${isPerfect ? 'perfect' : ''}`;
        item.onclick = () => setDashboardDate(dateStr);
        
        item.innerHTML = `
            <span class="timeline-day">${d.toLocaleDateString('ko-KR', { weekday: 'short' })}</span>
            <span class="timeline-num">${d.getDate()}</span>
            ${hasData ? `<div class="timeline-indicator ${isPerfect ? 'success' : ''}"></div>` : ''}
        `;
        container.appendChild(item);
    }
}

function updateDate() {
    const el = document.getElementById('current-date');
    if (el) el.textContent = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
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
                const targetDate = state.viewDate || getTodayStr();
                const isDone = isCompletedInCycle(q, targetDate);
                const newState = !isDone;
                
                // 마스터 상태 즉시 변경
                q.completed = newState; 
                if (newState) q.completedAt = targetDate;
                else delete q.completedAt;
                
                addLog('complete', `숙제 완료 상태 변경: [${q.game}] ${q.title} (${targetDate})`);
                // 모든 관련 히스토리 일괄 갱신
                syncStatusAcrossHistory(q, targetDate);
                
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
        if (target.closest('.delete-quest-btn')) {
            const id = parseInt(target.closest('.delete-quest-btn').dataset.id);
            const q = state.quests.find(x => x.id === id);
            if (confirm("정말 삭제하시겠습니까? (이전 기록은 유지됩니다)")) {
                if (q) addLog('delete', `숙제 삭제됨: [${q.game}] ${q.title}`);
                state.quests = state.quests.filter(q => q.id !== id);
                render(); save();
            }
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
                addLog('delete', `숙제 영구 삭제: ${qH.title}`);
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
                if (state.gameIcons && state.gameIcons[old]) {
                    state.gameIcons[n] = state.gameIcons[old];
                    delete state.gameIcons[old];
                }
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
                addLog('delete', `게임 삭제됨: ${name}`);
                state.quests = state.quests.filter(q => q.game !== name);
                state.games = state.games.filter(g => g !== name);
                if (state.gameIcons) delete state.gameIcons[name];
                if (state.activeGame === name) {
                    state.activeGame = state.games.length > 0 ? state.games[0] : '';
                }
                render(); save(); 
            }
        }
        if (target.id === 'btn-clear-all') {
            if (confirm("⚠️ 경고: 모든 데이터(숙제, 기록)가 영구 삭제됩니다. 계속하시겠습니까?") && 
                confirm("정말로 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.")) {
                state.quests = [];
                state.history = {};
                state.games = [];
                addLog('info', '모든 데이터가 초기화되었습니다.');
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
            addLog('backup', `신규 백업 생성됨: ${snap.name}`);
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
                addLog('backup', `백업 데이터 복구 완료 (${b.date})`);
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
            const { calendarDate, backups, user, ...toExport } = state;
            const data = {
                ...toExport,
                backups: state.backups // 백업도 포함하려면 유지
            };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `quest_master_backup_${new Date().toLocaleDateString()}.json`;
            a.click();
            URL.revokeObjectURL(url);
            addLog('info', '데이터 백업 파일(JSON) 내보내기 완료');
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
                            // 백업본이 있다면 합치거나 덮어씌움
                            const { calendarDate, user, ...rest } = imported;
                            state = { ...state, ...rest };
                            
                            // 노트가 문자열이면 배열로 변환
                            if (typeof state.notes === 'string') {
                                state.notes = [{ id: Date.now(), title: '불러온 메모', content: state.notes, date: new Date().toISOString() }];
                            }
                            
                            addLog('info', '파일로부터 데이터를 성공적으로 불러왔습니다.');
                            render(); save(true); // 동기화 액션으로 저장
                            showToast("데이터를 성공적으로 불러왔습니다.", "info");
                        }
                    } catch (err) {
                        showToast("유효하지 않은 파일 형식입니다.");
                    }
                    e.target.value = ''; // 초기화
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
        else if (id === 'nav-gallery') state.currentView = 'gallery';
        else if (id === 'nav-todo') state.currentView = 'todo';
        else if (id === 'nav-log') state.currentView = 'log';
        else if (id === 'nav-settings') state.currentView = 'settings';
        render();
        return; 
    }
        if (target.id === 'btn-add-game') {
            const name = prompt("새 탭 이름:");
            if (name && !state.games.includes(name)) { 
                state.games.push(name); 
                addLog('add', `새 탭 추가됨: ${name}`);
                if (!state.activeGame) state.activeGame = name;
                render(); save(); 
            }
        }
        if (target.id === 'prev-month') { state.calendarDate.setMonth(state.calendarDate.getMonth() - 1); render(); }
        if (target.id === 'next-month') { state.calendarDate.setMonth(state.calendarDate.getMonth() + 1); render(); }
        if (target.id === 'btn-login') { if (typeof firebase !== 'undefined') firebase.auth().signInWithPopup(new firebase.auth.GoogleAuthProvider()); }
        if (target.id === 'btn-logout') { if (typeof firebase !== 'undefined') firebase.auth().signOut(); }
        if (target.id === 'btn-sync') await syncCloud();
        if (target.id === 'add-quest-btn') { document.getElementById('modal-container').classList.remove('hidden'); renderForm(); }
        if (target.id === 'close-modal') document.getElementById('modal-container').classList.add('hidden');
        if (target.id === 'btn-add-todo') {
            const title = prompt("할 일 내용을 입력하세요:");
            if (title) {
                if (!state.todos) state.todos = [];
                const newTodo = { 
                    id: Date.now(), 
                    title, 
                    completed: false,
                    createdAt: Date.now() 
                };
                state.todos.push(newTodo);
                addLog('add', `새 일회용 숙제 추가됨: ${title}`);
                save(); renderTodo();
            }
        }
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
            <div class="form-row">
                <div class="form-group flex-1">
                    <label><i data-lucide="calendar-days"></i> 시작일 (적용일)</label>
                    <input type="date" id="in-date" value="${defaultDate}">
                </div>
                <div class="form-group flex-1" id="enddate-input" style="${editQuest && editQuest.type === 'once' ? 'display: none;' : 'display: block;'}">
                    <label><i data-lucide="calendar-x"></i> 반복 종료일 <span class="label-hint">(선택)</span></label>
                    <input type="date" id="in-enddate" value="${editQuest && editQuest.endDate ? editQuest.endDate : ''}">
                </div>
            </div>
            <div class="form-group">
                <label><i data-lucide="type"></i> 숙제 내용</label>
                <input type="text" id="in-title" value="${editQuest ? editQuest.title : ''}" placeholder="예: 숙제 이름" required>
            </div>
            <div class="form-group">
                <label><i data-lucide="gamepad-2"></i> 게임 선택</label>
                <select id="in-game">${state.games.map(g => `<option value="${g}" ${editQuest && editQuest.game === g ? 'selected' : ''}>${g}</option>`).join('')}<option value="_new">+ 추가</option></select>
            </div>
            <div class="form-group">
                <label><i data-lucide="refresh-cw"></i> 반복 주기</label>
                <select id="in-type" onchange="
                    document.getElementById('interval-input').style.display = this.value === 'interval' ? 'block' : 'none';
                    document.getElementById('enddate-input').style.display = this.value === 'once' ? 'none' : 'block';
                ">
                    <option value="once" ${editQuest && editQuest.type === 'once' ? 'selected' : ''}>반복 안함 (일회성)</option>
                    <option value="daily" ${editQuest && editQuest.type === 'daily' ? 'selected' : ''}>매일</option>
                    <option value="weekly" ${editQuest && editQuest.type === 'weekly' ? 'selected' : ''}>매주</option>
                    <option value="biweekly" ${editQuest && editQuest.type === 'biweekly' ? 'selected' : ''}>격주</option>
                    <option value="interval" ${editQuest && editQuest.type === 'interval' ? 'selected' : ''}>N일마다</option>
                </select>
            </div>
            <div class="form-group" id="interval-input" style="${editQuest && editQuest.type === 'interval' ? 'display: block;' : 'display: none;'}">
                <label><i data-lucide="hash"></i> 반복 일수 (N)</label>
                <input type="number" id="in-interval" value="${editQuest ? editQuest.interval : 2}" min="1">
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
            if (name) { 
                state.games.push(name); 
                addLog('add', `게임 추가됨: ${name}`);
                game = name; 
            } else return;
        }
        const endDateVal = document.getElementById('in-enddate') ? document.getElementById('in-enddate').value : '';
        const formData = { 
            title: document.getElementById('in-title').value, 
            game: game, 
            type: document.getElementById('in-type').value, 
            interval: document.getElementById('in-interval').value, 
            createdAt: selectedDate,
            endDate: endDateVal || null
        };
        if (editQuest) { 
            Object.assign(state.quests.find(x => x.id === editQuest.id), formData); 
            addLog('edit', `숙제 수정됨: [${game}] ${formData.title}`);
            syncQuestsToHistoryFromDate(selectedDate);
        }
        else {
            const newQuest = { id: Date.now(), ...formData, completed: false };
            state.quests.push(newQuest);
            addLog('add', `새 숙제 추가됨: [${game}] ${formData.title} (${formData.type})`);
            syncQuestsToHistoryFromDate(selectedDate);
        }
        document.getElementById('modal-container').classList.add('hidden');
        render(); save();
    };
    if (window.lucide) lucide.createIcons();
}

function addLog(action, detail) {
    if (!state.logs) state.logs = [];
    state.logs.push({ id: Date.now(), action: action, detail: detail });
    // 최근 200개까지만 유지하여 용량 최적화
    if (state.logs.length > 200) {
        state.logs = state.logs.slice(-200);
    }
}

function clearLogs() {
    if (confirm("모든 시스템 로그를 삭제하시겠습니까?")) {
        state.logs = [];
        addLog('info', '모든 로그가 초기화되었습니다.');
        save();
        renderLog();
        if (window.lucide) lucide.createIcons();
    }
}

// --- Drag & Drop Logic ---
let dragSrcEl = null;

function handleDragStart(e) {
    dragSrcEl = this;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', this.getAttribute('data-id'));
    this.classList.add('dragging');
}

function handleDragOver(e) {
    if (e.preventDefault) e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    return false;
}

function handleDrop(e) {
    if (e.stopPropagation) e.stopPropagation();
    
    const targetId = this.getAttribute('data-id');
    const sourceId = e.dataTransfer.getData('text/plain');
    
    if (sourceId !== targetId) {
        const sourceIndex = state.quests.findIndex(q => q.id == sourceId);
        const targetIndex = state.quests.findIndex(q => q.id == targetId);
        
        const [movedQuest] = state.quests.splice(sourceIndex, 1);
        state.quests.splice(targetIndex, 0, movedQuest);
        
        addLog('edit', `숙제 순서 변경됨: ${movedQuest.title}`);
        save();
        render();
    }
    return false;
}

function handleDragEnd(e) {
    this.classList.remove('dragging');
    const cards = document.querySelectorAll('.quest-card');
    cards.forEach(c => c.classList.remove('drag-over'));
}

// --- Lightbox Functions ---
function openLightbox(src) {
    const modal = document.getElementById('lightbox-modal');
    const img = document.getElementById('lightbox-img');
    if (modal && img) {
        img.src = src;
        modal.classList.remove('hidden');
        // 클릭 시 이벤트 전파 방지 (이미지 클릭해도 안 닫히게)
        img.onclick = (e) => e.stopPropagation();
        if (window.lucide) lucide.createIcons();
    }
}

function openOriginal(src) {
    const newTab = window.open();
    newTab.document.body.innerHTML = `<img src="${src}" style="max-width:100%; cursor:zoom-out;" onclick="window.close()">`;
    newTab.document.title = "원본 이미지 보기";
}

function closeLightbox() {
    const modal = document.getElementById('lightbox-modal');
    if (modal) {
        modal.classList.add('hidden');
    }
}

// PC용 키보드 단축키 (ESC)
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeLightbox();
    }
});

window.updateSiteIcon = function(input) {
    const file = input.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            state.appIcon = e.target.result;
            let link = document.querySelector("link[rel*='icon']");
            if (!link) {
                link = document.createElement('link');
                link.rel = 'shortcut icon';
                document.head.appendChild(link);
            }
            link.href = e.target.result;
            save();
            render();
            addLog('info', '사이트 아이콘이 변경되었습니다.');
        };
        reader.readAsDataURL(file);
    }
};

// --- 자동 백업 로직 ---
function checkAutoBackup() {
    const key = getAutoBackupKey();
    const lastAutoTime = localStorage.getItem(key + '_TIME');
    const now = Date.now();
    const twelveHours = 12 * 60 * 60 * 1000;

    if (!lastAutoTime || (now - parseInt(lastAutoTime)) > twelveHours) {
        performAutoBackup();
    }
}

function performAutoBackup() {
    const key = getAutoBackupKey();
    let autoBackups = [];
    try {
        const saved = localStorage.getItem(key);
        if (saved) autoBackups = JSON.parse(saved);
    } catch (e) {}

    const { calendarDate, backups, user, ...toBackup } = state;
    const newBackup = {
        id: Date.now(),
        date: new Date().toLocaleString('ko-KR'),
        ...JSON.parse(JSON.stringify(toBackup))
    };

    autoBackups.unshift(newBackup);
    if (autoBackups.length > 3) autoBackups = autoBackups.slice(0, 3); // 최신 3개만 유지

    localStorage.setItem(key, JSON.stringify(autoBackups));
    localStorage.setItem(key + '_TIME', Date.now().toString());
    console.log("Auto-backup completed.");
}

function renderAutoBackupList() {
    const container = document.getElementById('auto-backup-list');
    if (!container) return;

    const key = getAutoBackupKey();
    let autoBackups = [];
    try {
        const saved = localStorage.getItem(key);
        if (saved) autoBackups = JSON.parse(saved);
    } catch (e) {}

    if (autoBackups.length === 0) {
        container.innerHTML = '<p class="empty-msg-sm">아직 자동 백업이 없습니다.</p>';
        return;
    }

    container.innerHTML = autoBackups.map((b, idx) => `
        <button class="btn btn-sm" style="background: rgba(255,255,255,0.05); border: 1px solid var(--border); color: var(--text-dim);" 
                onclick="restoreAutoBackup(${idx})">
            <i data-lucide="history" style="width: 12px; margin-right: 4px;"></i> ${b.date.split(' ').slice(1).join(' ')} 복구
        </button>
    `).join('');
}

window.restoreAutoBackup = function(idx) {
    const key = getAutoBackupKey();
    try {
        const autoBackups = JSON.parse(localStorage.getItem(key));
        const b = autoBackups[idx];
        if (confirm(`[${b.date}] 자동 백업으로 복구할까요?\n현재 데이터가 덮어씌워집니다.`)) {
            state.quests = b.quests;
            state.history = b.history;
            state.games = b.games;
            state.appTitle = b.appTitle || state.appTitle;
            state.todos = b.todos || [];
            addLog('backup', `자동 백업 복구 완료 (${b.date})`);
            save(); render();
            showToast("자동 백업에서 복구되었습니다.", "info");
        }
    } catch (e) {
        showToast("복구 중 오류가 발생했습니다.");
    }
}


