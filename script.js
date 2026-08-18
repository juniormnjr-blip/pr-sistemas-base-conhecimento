const state = {
    currentUser: null,
    posts: [],
    configs: {
        modules: ['Geral'],
        categories: ['Erro']
    },
    users: [],
    unitVersions: [],
    unitVersionsSourceConfigured: false,
    unitVersionsIngestConfigured: false
};

let isReturningToLogin = false;
let realtimeSource = null;
let realtimeReconnectTimer = null;
let realtimeSyncInFlight = null;

document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    bootstrapApp();
});

window.addEventListener('popstate', function () {
    if (state.currentUser && !isReturningToLogin) {
        returnToLogin();
    }
});

function setupEventListeners() {
    document.getElementById('btn-login-trigger').onclick = login;

    ['login-user', 'login-pass'].forEach(id => {
        document.getElementById(id).addEventListener('keydown', function (event) {
            if (event.key === 'Enter') {
                event.preventDefault();
                login();
            }
        });
    });

    document.getElementById('btn-logout-trigger').onclick = logout;

    document.getElementById('nav-view-btn').onclick = () => showTab('view');
    document.getElementById('nav-unit-versions-btn').onclick = () => showTab('unit-versions');

    document.getElementById('nav-editor').onclick = () => {
        resetForm();
        showTab('create');
    };

    document.getElementById('nav-settings-btn').onclick = () => showTab('settings');

    document.getElementById('search-bar').oninput = renderCards;
    document.getElementById('unit-version-search').oninput = renderUnitVersions;
    document.getElementById('filter-module').onchange = renderCards;
    document.getElementById('filter-category').onchange = renderCards;
    document.getElementById('btn-sync-unit-versions').onclick = syncUnitVersionsNow;

    document.getElementById('btn-add-module').onclick = addModule;
    document.getElementById('btn-add-category').onclick = addCategory;
    document.getElementById('btn-create-user').onclick = createUser;

    document.getElementById('wiki-form').onsubmit = handleFormSubmit;

    document.getElementById('btn-cancel-edit').onclick = resetForm;

    document.getElementById('btn-close-modal').onclick = () => {
        document.getElementById('modal-detail').classList.add('hidden');
    };

    document.getElementById('post-files-problem').onchange = (event) => {
        const total = event.target.files.length;
        document.getElementById('label-files-problem').innerText =
            total > 0 ? `${total} arquivo(s)` : 'Nenhum';
    };

    document.getElementById('post-files-solution').onchange = (event) => {
        const total = event.target.files.length;
        document.getElementById('label-files-solution').innerText =
            total > 0 ? `${total} arquivo(s)` : 'Nenhum';
    };
}

async function bootstrapApp() {
    try {
        await loadBootstrapData();

        history.replaceState({ page: 'login' }, '', window.location.pathname);

        if (state.currentUser) {
            history.pushState({ page: 'app' }, '', '#app');
            initAppUI();
            startRealtimeSync();
        } else {
            stopRealtimeSync();
            showLoginScreen();
        }
    } catch (error) {
        console.error(error);
        alert('Não foi possível conectar ao servidor. Verifique se o backend está rodando.');
        stopRealtimeSync();
        showLoginScreen();
    }
}

async function loadBootstrapData() {
    const data = await api('/api/bootstrap');

    state.currentUser = data.user || null;
    state.posts = data.posts || [];
    state.configs = data.configs || state.configs;
    state.users = state.currentUser?.role === 'admin' ? (data.users || []) : [];
    state.unitVersions = data.unitVersions || [];
    state.unitVersionsSourceConfigured = Boolean(data.unitVersionsSourceConfigured);
    state.unitVersionsIngestConfigured = Boolean(data.unitVersionsIngestConfigured);

    return data;
}

async function api(url, options = {}) {
    const response = await fetch(url, {
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        },
        ...options
    });

    const text = await response.text();
    let data = {};

    if (text) {
        try {
            data = JSON.parse(text);
        } catch (error) {
            data = {};
        }
    }

    if (!response.ok) {
        throw new Error(data.error || 'Erro inesperado.');
    }

    return data;
}

async function login() {
    const u = document.getElementById('login-user').value.trim();
    const p = document.getElementById('login-pass').value;

    if (!u || !p) {
        alert('Informe usuário e senha.');
        return;
    }

    try {
        await api('/api/login', {
            method: 'POST',
            body: JSON.stringify({ user: u, pass: p })
        });

        await bootstrapApp();
    } catch (error) {
        alert('Acesso negado.');
    }
}

async function logout() {
    try {
        await api('/api/logout', { method: 'POST' });
    } catch (error) {
        console.error(error);
    }

    stopRealtimeSync();
    returnToLogin();
}

function returnToLogin() {
    isReturningToLogin = true;

    state.currentUser = null;
    stopRealtimeSync();

    showLoginScreen();

    history.replaceState({ page: 'login' }, '', window.location.pathname);

    setTimeout(() => {
        isReturningToLogin = false;
    }, 100);
}

function showLoginScreen() {
    document.getElementById('app').classList.add('hidden');
    document.getElementById('login-screen').classList.remove('hidden');

    document.getElementById('login-user').value = '';
    document.getElementById('login-pass').value = '';

    document.getElementById('nav-editor').classList.add('hidden');
    document.getElementById('section-admin').classList.add('hidden');

    document.getElementById('modal-detail').classList.add('hidden');
}

function initAppUI() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');

    document.getElementById('logged-user-name').innerText = state.currentUser.user;
    document.getElementById('logged-user-role').innerText = state.currentUser.role.toUpperCase();
    document.getElementById('user-initial').innerText = state.currentUser.user.charAt(0).toUpperCase();

    if (['admin', 'editor'].includes(state.currentUser.role)) {
        document.getElementById('nav-editor').classList.remove('hidden');
    }

    if (state.currentUser.role === 'admin') {
        document.getElementById('section-admin').classList.remove('hidden');
    }

    refreshDropdowns();
    renderAdminLists();
    renderCards();
    renderUnitVersions();
    document.getElementById('btn-sync-unit-versions').classList.toggle(
        'hidden',
        !['admin', 'editor'].includes(state.currentUser.role) || !state.unitVersionsSourceConfigured
    );
    showTab('view');
}

function showTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.add('hidden');
    });

    document.querySelectorAll('.nav-item').forEach(button => {
        button.classList.remove('active');
    });

    document.getElementById(`tab-${tabId}`).classList.remove('hidden');

    const navMap = {
        view: 'nav-view-btn',
        'unit-versions': 'nav-unit-versions-btn',
        create: 'nav-editor',
        settings: 'nav-settings-btn'
    };

    const navButton = document.getElementById(navMap[tabId]);
    if (navButton) {
        navButton.classList.add('active');
    }
}

async function handleFormSubmit(event) {
    event.preventDefault();

    const isEdit = document.getElementById('post-id').value;
    const problemInput = document.getElementById('post-files-problem');
    const solutionInput = document.getElementById('post-files-solution');
    const currentPost = isEdit ? state.posts.find(post => String(post.id) === String(isEdit)) : null;

    const newProblemFiles = await filesToBase64(problemInput.files);
    const newSolutionFiles = await filesToBase64(solutionInput.files);

    const postData = {
        title: document.getElementById('post-title').value.trim(),
        module: document.getElementById('post-module').value,
        category: document.getElementById('post-category').value,
        problem: document.getElementById('post-problem').value.trim(),
        solution: document.getElementById('post-solution').value.trim(),
        problemImages: newProblemFiles.length > 0 ? newProblemFiles : (currentPost?.problemImages || []),
        solutionImages: newSolutionFiles.length > 0 ? newSolutionFiles : (currentPost?.solutionImages || [])
    };

    if (!postData.title || !postData.problem || !postData.solution) {
        alert('Preencha título, problema e solução.');
        return;
    }

    try {
        if (isEdit) {
            const response = await api(`/api/posts/${encodeURIComponent(isEdit)}`, {
                method: 'PUT',
                body: JSON.stringify(postData)
            });

            state.posts = state.posts.map(post => (String(post.id) === String(isEdit) ? response.post : post));
        } else {
            const response = await api('/api/posts', {
                method: 'POST',
                body: JSON.stringify(postData)
            });

            state.posts.unshift(response.post);
        }

        resetForm();
        renderCards();
        showTab('view');
    } catch (error) {
        alert(error.message || 'Não foi possível salvar o artigo.');
        console.error(error);
    }
}

function startRealtimeSync() {
    if (!state.currentUser || typeof EventSource === 'undefined') {
        return;
    }

    stopRealtimeSync();

    realtimeSource = new EventSource('/api/events', { withCredentials: true });
    realtimeSource.onmessage = handleRealtimeMessage;
    realtimeSource.onerror = handleRealtimeError;
}

function stopRealtimeSync() {
    if (realtimeReconnectTimer) {
        clearTimeout(realtimeReconnectTimer);
        realtimeReconnectTimer = null;
    }

    if (realtimeSource) {
        realtimeSource.close();
        realtimeSource = null;
    }
}

function handleRealtimeError() {
    if (!state.currentUser) {
        return;
    }

    if (realtimeReconnectTimer) {
        return;
    }

    if (realtimeSource) {
        realtimeSource.close();
        realtimeSource = null;
    }

    realtimeReconnectTimer = setTimeout(() => {
        realtimeReconnectTimer = null;

        if (state.currentUser) {
            startRealtimeSync();
        }
    }, 3000);
}

function handleRealtimeMessage(event) {
    if (!state.currentUser || !event.data) {
        return;
    }

    let payload = null;

    try {
        payload = JSON.parse(event.data);
    } catch (error) {
        payload = null;
    }

    if (!payload || payload.type === 'connected') {
        return;
    }

    syncRealtimeState();
}

async function syncRealtimeState() {
    if (!state.currentUser || realtimeSyncInFlight) {
        return realtimeSyncInFlight;
    }

    realtimeSyncInFlight = (async () => {
        const activeTab = document.querySelector('.tab-content:not(.hidden)')?.id?.replace('tab-', '') || 'view';
        const editingId = document.getElementById('post-id').value;
        const isEditing = Boolean(editingId);
        const savedModule = document.getElementById('post-module').value;
        const savedCategory = document.getElementById('post-category').value;
        const savedFilterModule = document.getElementById('filter-module').value;
        const savedFilterCategory = document.getElementById('filter-category').value;

        const data = await loadBootstrapData();
        if (!data.user) {
            stopRealtimeSync();
            returnToLogin();
            return;
        }

        refreshDropdowns({
            savedModule,
            savedCategory,
            savedFilterModule,
            savedFilterCategory
        });
        renderAdminLists();
        renderCards();
        renderUnitVersions();

        if (isEditing && editingId) {
            const post = state.posts.find(item => String(item.id) === String(editingId));
            if (post) {
                document.getElementById('post-title').value = post.title || '';
                document.getElementById('post-module').value = post.module || '';
                document.getElementById('post-category').value = post.category || '';
                document.getElementById('post-problem').value = post.problem || '';
                document.getElementById('post-solution').value = post.solution || '';
            }
        }

        showTab(activeTab);
    })().catch(error => {
        console.error('Falha ao sincronizar realtime.', error);
    }).finally(() => {
        realtimeSyncInFlight = null;
    });

    return realtimeSyncInFlight;
}

function filesToBase64(fileList) {
    const files = Array.from(fileList || []);

    const allowedFiles = files.filter(file => {
        return file.type.startsWith('image/');
    });

    if (files.length !== allowedFiles.length) {
        alert('Alguns arquivos foram ignorados. Apenas imagens e GIFs são aceitos.');
    }

    return Promise.all(allowedFiles.map(file => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();

            reader.onload = () => {
                resolve({
                    name: file.name,
                    type: file.type,
                    size: file.size,
                    data: reader.result
                });
            };

            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }));
}

function renderCards() {
    const grid = document.getElementById('wiki-grid');
    const search = document.getElementById('search-bar').value.toLowerCase();
    const filterModule = document.getElementById('filter-module').value;
    const filterCategory = document.getElementById('filter-category').value;

    grid.innerHTML = '';

    const filteredPosts = state.posts.filter(post => {
        const title = post.title || '';
        const module = post.module || '';
        const category = post.category || '';

        const matchesSearch = title.toLowerCase().includes(search);
        const matchesModule = !filterModule || module === filterModule;
        const matchesCategory = !filterCategory || category === filterCategory;

        return matchesSearch && matchesModule && matchesCategory;
    });

    if (filteredPosts.length === 0) {
        grid.innerHTML = `
            <div class="empty-state">
                <i class="ph ph-file-search"></i>
                <p>Nenhum artigo encontrado.</p>
            </div>
        `;
        return;
    }

    filteredPosts.forEach(post => {
        const card = document.createElement('div');
        card.className = 'card';

        let actions = '';

        if (state.currentUser && ['admin', 'editor'].includes(state.currentUser.role)) {
            actions = `
                <div class="action-btns">
                    <button onclick="loadEditForm('${escapeAttr(post.id)}', event)" title="Editar">
                        <i class="ph ph-pencil-simple"></i>
                    </button>
                    <button class="del" onclick="deletePost('${escapeAttr(post.id)}', event)" title="Excluir">
                        <i class="ph ph-trash"></i>
                    </button>
                </div>
            `;
        }

        const thumbnail = getPostThumbnail(post);

        const thumbnailHtml = thumbnail
            ? `
                <div class="card-thumb" onclick="openArticle('${escapeAttr(post.id)}')">
                    <img src="${thumbnail.data}" alt="${escapeAttr(thumbnail.name || 'Imagem do artigo')}">
                </div>
            `
            : '';

        const totalImages = countPostImages(post);

        const imageCounterHtml = totalImages > 0
            ? `<span><i class="ph ph-image"></i> ${totalImages} imagem(ns)</span>`
            : '';

        card.innerHTML = `
            ${thumbnailHtml}

            <div class="card-header">
                <div>
                    <span class="tag tag-module">${escapeHTML(post.module || '')}</span>
                    <span class="tag">${escapeHTML(post.category || '')}</span>
                </div>
                ${actions}
            </div>

            <h3 onclick="openArticle('${escapeAttr(post.id)}')">${escapeHTML(post.title || '')}</h3>

            <p onclick="openArticle('${escapeAttr(post.id)}')">
                ${escapeHTML((post.problem || '').substring(0, 100))}${(post.problem || '').length > 100 ? '...' : ''}
            </p>

            <div class="card-footer">
                <span><i class="ph ph-user"></i> ${escapeHTML(post.author || '')}</span>
                ${imageCounterHtml || `<span><i class="ph ph-calendar"></i> ${escapeHTML(post.date || '')}</span>`}
            </div>
        `;

        grid.appendChild(card);
    });
}

function getPostThumbnail(post) {
    if (post.problemImages && post.problemImages.length > 0) {
        return post.problemImages[0];
    }

    if (post.solutionImages && post.solutionImages.length > 0) {
        return post.solutionImages[0];
    }

    return null;
}

function countPostImages(post) {
    const problemCount = post.problemImages?.length || 0;
    const solutionCount = post.solutionImages?.length || 0;

    return problemCount + solutionCount;
}

async function deletePost(id, event) {
    event.stopPropagation();

    if (confirm('Excluir card?')) {
        try {
            await api(`/api/posts/${encodeURIComponent(id)}`, { method: 'DELETE' });
            state.posts = state.posts.filter(post => String(post.id) !== String(id));
            renderCards();
        } catch (error) {
            alert(error.message || 'Não foi possível excluir.');
        }
    }
}

function loadEditForm(id, event) {
    event.stopPropagation();

    const post = state.posts.find(item => String(item.id) === String(id));

    if (!post) return;

    document.getElementById('post-id').value = post.id;
    document.getElementById('post-title').value = post.title || '';
    document.getElementById('post-module').value = post.module || '';
    document.getElementById('post-category').value = post.category || '';
    document.getElementById('post-problem').value = post.problem || '';
    document.getElementById('post-solution').value = post.solution || '';

    document.getElementById('editor-title').innerText = 'Editar Artigo';
    document.getElementById('btn-save-post').innerText = 'Salvar Alterações';
    document.getElementById('btn-cancel-edit').classList.remove('hidden');

    const problemCount = post.problemImages?.length || 0;
    const solutionCount = post.solutionImages?.length || 0;

    document.getElementById('label-files-problem').innerText = problemCount > 0
        ? `${problemCount} arquivo(s) salvo(s)`
        : 'Nenhum';

    document.getElementById('label-files-solution').innerText = solutionCount > 0
        ? `${solutionCount} arquivo(s) salvo(s)`
        : 'Nenhum';

    showTab('create');
}

function resetForm() {
    document.getElementById('wiki-form').reset();

    document.getElementById('post-id').value = '';
    document.getElementById('editor-title').innerText = 'Novo Registro';
    document.getElementById('btn-save-post').innerText = 'Publicar na Wiki';
    document.getElementById('btn-cancel-edit').classList.add('hidden');

    document.getElementById('label-files-problem').innerText = 'Nenhum';
    document.getElementById('label-files-solution').innerText = 'Nenhum';
}

async function addModule() {
    const input = document.getElementById('new-module-name');
    const value = input.value.trim();

    if (!value) return;

    try {
        const response = await api('/api/configs/modules', {
            method: 'POST',
            body: JSON.stringify({ name: value })
        });

        state.configs = response.configs;
        input.value = '';
        refreshDropdowns();
        renderAdminLists();
    } catch (error) {
        alert(error.message || 'Não foi possível adicionar o módulo.');
    }
}

async function addCategory() {
    const input = document.getElementById('new-category-name');
    const value = input.value.trim();

    if (!value) return;

    try {
        const response = await api('/api/configs/categories', {
            method: 'POST',
            body: JSON.stringify({ name: value })
        });

        state.configs = response.configs;
        input.value = '';
        refreshDropdowns();
        renderAdminLists();
    } catch (error) {
        alert(error.message || 'Não foi possível adicionar a categoria.');
    }
}

async function createUser() {
    const usernameInput = document.getElementById('new-username');
    const passwordInput = document.getElementById('new-password');
    const roleInput = document.getElementById('new-role');

    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    const role = roleInput.value;

    if (!username || !password) return;

    try {
        await api('/api/users', {
            method: 'POST',
            body: JSON.stringify({ username, password, role })
        });

        usernameInput.value = '';
        passwordInput.value = '';

        await refreshAdminUsers();
        renderAdminLists();
    } catch (error) {
        alert(error.message || 'Não foi possível criar o usuário.');
    }
}

function escapeAttr(value) {
    return escapeHTML(value).replaceAll('`', '&#096;');
}

async function deleteConfig(type, item) {
    const endpoint = type === 'modules'
        ? `/api/configs/modules/${encodeURIComponent(item)}`
        : `/api/configs/categories/${encodeURIComponent(item)}`;

    try {
        const response = await api(endpoint, { method: 'DELETE' });
        state.configs = response.configs;
        refreshDropdowns();
        renderAdminLists();
    } catch (error) {
        alert(error.message || 'Não foi possível remover.');
    }
}

async function deleteUser(username) {
    if (username === 'admin') return;

    try {
        await api(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
        await refreshAdminUsers();
        renderAdminLists();
    } catch (error) {
        alert(error.message || 'Não foi possível remover o usuário.');
    }
}

function renderAdminLists() {
    const configs = state.configs;

    document.getElementById('list-modules').innerHTML = configs.modules.map(module => `
        <div class="list-item">
            <span>${escapeHTML(module)}</span>
            <button onclick="deleteConfig('modules', '${escapeAttr(module)}')">Excluir</button>
        </div>
    `).join('');

    document.getElementById('list-categories').innerHTML = configs.categories.map(category => `
        <div class="list-item">
            <span>${escapeHTML(category)}</span>
            <button onclick="deleteConfig('categories', '${escapeAttr(category)}')">Excluir</button>
        </div>
    `).join('');

    document.getElementById('list-users').innerHTML = state.users.map(userData => `
        <div class="list-item">
            <span>${escapeHTML(userData.user)} (${escapeHTML(userData.role)})</span>
            ${
                userData.user !== 'admin'
                    ? `<button onclick="deleteUser('${escapeAttr(userData.user)}')">Remover</button>`
                    : ''
            }
        </div>
    `).join('');
}

function renderUnitVersions() {
    const grid = document.getElementById('unit-versions-grid');
    const status = document.getElementById('unit-versions-status');
    const syncButton = document.getElementById('btn-sync-unit-versions');
    const search = document.getElementById('unit-version-search').value.toLowerCase().trim();
    const unitVersions = Array.isArray(state.unitVersions) ? state.unitVersions : [];

    if (status) {
        if (state.unitVersionsSourceConfigured) {
            status.innerHTML = '<span class="sync-badge live"><i class="ph ph-broadcast"></i> Sincronização automática ativa via servidor de origem</span>';
        } else if (state.unitVersionsIngestConfigured) {
            status.innerHTML = '<span class="sync-badge live"><i class="ph ph-cloud-arrow-up"></i> Agentes instalados estão enviando versões para a nuvem</span>';
        } else {
            status.innerHTML = '<span class="sync-badge muted"><i class="ph ph-plug"></i> Configure um servidor de origem ou o token do agente para ativar a coleta automática</span>';
        }
    }

    if (syncButton) {
        const canSync = Boolean(state.currentUser && ['admin', 'editor'].includes(state.currentUser.role) && state.unitVersionsSourceConfigured);
        syncButton.classList.toggle('hidden', !canSync);
    }

    if (!grid) return;

    const filtered = unitVersions.filter(unit => {
        const unitName = String(unit.unitName || '').toLowerCase();
        const companyMatches = Array.isArray(unit.companyNames) && unit.companyNames.some(companyName => {
            return String(companyName || '').toLowerCase().includes(search);
        });
        const moduleMatches = Array.isArray(unit.moduleVersions) && unit.moduleVersions.some(item => {
            const moduleName = String(item.moduleName || '').toLowerCase();
            const version = String(item.version || '').toLowerCase();
            return moduleName.includes(search) || version.includes(search);
        });

        return unitName.includes(search) || companyMatches || moduleMatches;
    });

    if (filtered.length === 0) {
        grid.innerHTML = `
            <div class="empty-state">
                <i class="ph ph-magnifying-glass"></i>
                <p>Nenhuma versão encontrada.</p>
            </div>
        `;
        return;
    }

    grid.innerHTML = filtered.map(unit => {
        const companies = Array.isArray(unit.companyNames) ? unit.companyNames.filter(Boolean) : [];
        const modules = Array.isArray(unit.moduleVersions) ? unit.moduleVersions : [];
        const companyChips = companies.length > 0
            ? companies.map(companyName => `<span class="company-chip">${escapeHTML(companyName)}</span>`).join('')
            : '<span class="company-chip empty">Nenhuma empresa encontrada</span>';
        const rows = modules.length > 0
            ? modules.map(item => `
                <div class="unit-version-row">
                    <span class="unit-version-module">${escapeHTML(item.moduleName || 'Módulo')}</span>
                    <strong class="unit-version-value">${escapeHTML(item.version || 'Sem versão')}</strong>
                </div>
            `).join('')
            : `
                <div class="unit-version-row muted-row">
                    <span>Sem módulos informados</span>
                    <strong>-</strong>
                </div>
            `;

        return `
            <article class="unit-version-card">
                <div class="unit-version-header">
                    <div>
                        <span class="tag tag-module">Empresa</span>
                        <h3>${escapeHTML(unit.unitName || '')}</h3>
                    </div>
                    <div class="unit-version-meta">
                        <span><i class="ph ph-clock"></i> ${escapeHTML(formatDateTime(unit.syncedAt || unit.updatedAt || unit.createdAt))}</span>
                        <span><i class="ph ph-buildings"></i> ${companies.length} empresa(s)</span>
                        <span><i class="ph ph-database"></i> ${modules.length} módulo(s)</span>
                    </div>
                </div>
                <div class="unit-version-section">
                    <div class="unit-version-section-label">Nomes das empresas encontrados no banco</div>
                    <div class="company-chip-list">
                        ${companyChips}
                    </div>
                </div>
                <div class="unit-version-list">
                    ${rows}
                </div>
            </article>
        `;
    }).join('');
}

async function syncUnitVersionsNow() {
    const button = document.getElementById('btn-sync-unit-versions');
    if (button) {
        button.disabled = true;
        button.innerHTML = '<i class="ph ph-spinner-gap"></i> Sincronizando...';
    }

    try {
        const response = await api('/api/unit-versions/sync', { method: 'POST' });
        state.unitVersions = response.unitVersions || [];
        state.unitVersionsSourceConfigured = Boolean(response.sourceConfigured);
        renderUnitVersions();
    } catch (error) {
        alert(error.message || 'Não foi possível sincronizar as versões.');
    } finally {
        if (button) {
            button.disabled = false;
            button.innerHTML = '<i class="ph ph-arrows-clockwise"></i> Sincronizar agora';
        }
    }
}

function formatDateTime(value) {
    if (!value) {
        return 'Sem data';
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return 'Data inválida';
    }

    return new Intl.DateTimeFormat('pt-BR', {
        dateStyle: 'short',
        timeStyle: 'short'
    }).format(date);
}

function refreshDropdowns(previousValues = {}) {
    const configs = state.configs;
    const currentModule = previousValues.savedModule ?? document.getElementById('post-module').value;
    const currentCategory = previousValues.savedCategory ?? document.getElementById('post-category').value;
    const currentFilterModule = previousValues.savedFilterModule ?? document.getElementById('filter-module').value;
    const currentFilterCategory = previousValues.savedFilterCategory ?? document.getElementById('filter-category').value;

    const moduleOptions = configs.modules.map(module => `
        <option value="${escapeAttr(module)}">${escapeHTML(module)}</option>
    `).join('');

    const categoryOptions = configs.categories.map(category => `
        <option value="${escapeAttr(category)}">${escapeHTML(category)}</option>
    `).join('');

    document.getElementById('post-module').innerHTML = moduleOptions;
    if (configs.modules.includes(currentModule)) {
        document.getElementById('post-module').value = currentModule;
    }

    document.getElementById('filter-module').innerHTML = `
        <option value="">Todos os Módulos</option>
        ${moduleOptions}
    `;
    if (configs.modules.includes(currentFilterModule)) {
        document.getElementById('filter-module').value = currentFilterModule;
    }

    document.getElementById('post-category').innerHTML = categoryOptions;
    if (configs.categories.includes(currentCategory)) {
        document.getElementById('post-category').value = currentCategory;
    }

    document.getElementById('filter-category').innerHTML = `
        <option value="">Todas as Categorias</option>
        ${categoryOptions}
    `;
    if (configs.categories.includes(currentFilterCategory)) {
        document.getElementById('filter-category').value = currentFilterCategory;
    }
}

async function refreshAdminUsers() {
    if (!state.currentUser || state.currentUser.role !== 'admin') {
        state.users = [];
        return;
    }

    try {
        const response = await api('/api/users');
        state.users = response.users || [];
    } catch (error) {
        console.error(error);
    }
}

function openArticle(id) {
    const post = state.posts.find(item => String(item.id) === String(id));

    if (!post) return;

    document.getElementById('modal-meta').innerHTML = `
        <span class="tag">${escapeHTML(post.module || '')}</span>
        <span class="tag">${escapeHTML(post.category || '')}</span>
    `;

    const problemImagesHtml = renderImageGallery(post.problemImages || []);
    const solutionImagesHtml = renderImageGallery(post.solutionImages || []);

    document.getElementById('modal-body').innerHTML = `
        <h1>${escapeHTML(post.title || '')}</h1>

        <div class="article-info">
            <span><i class="ph ph-user"></i> ${escapeHTML(post.author || '')}</span>
            <span><i class="ph ph-calendar"></i> Criado em ${escapeHTML(post.date || '')}</span>
            <span><i class="ph ph-clock"></i> Atualizado em ${escapeHTML(post.updatedAt || post.date || '')}</span>
        </div>

        <div class="content-box">
            <h4><i class="ph ph-warning-circle"></i> Problema</h4>
            <p>${formatText(post.problem || '')}</p>
            ${problemImagesHtml}
        </div>

        <div class="content-box">
            <h4><i class="ph ph-check-circle"></i> Solução</h4>
            <p>${formatText(post.solution || '')}</p>
            ${solutionImagesHtml}
        </div>
    `;

    document.getElementById('modal-detail').classList.remove('hidden');
}

function renderImageGallery(images) {
    if (!images || images.length === 0) return '';

    return `
        <div class="image-gallery">
            ${images.map((image, index) => `
                <button 
                    type="button"
                    class="article-image-link"
                    onclick="openImageViewer(${JSON.stringify(image.data)}, ${JSON.stringify(image.name || 'Imagem anexada')})"
                    title="${escapeAttr(image.name || 'Imagem anexada')}"
                >
                    <img 
                        src="${image.data}" 
                        alt="${escapeAttr(image.name || 'Imagem anexada')}" 
                        class="article-image"
                    >

                    <div class="image-name">
                        ${escapeHTML(image.name || 'Imagem anexada')}
                    </div>
                </button>
            `).join('')}
        </div>
    `;
}

function formatText(text) {
    return escapeHTML(text).replace(/\n/g, '<br>');
}

function escapeHTML(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function openImageViewer(imageData, imageName) {
    const oldViewer = document.querySelector('.image-viewer-overlay');

    if (oldViewer) {
        oldViewer.remove();
    }

    const viewer = document.createElement('div');
    viewer.className = 'image-viewer-overlay';

    viewer.innerHTML = `
        <div class="image-viewer-box">
            <button class="image-viewer-close" type="button" title="Fechar">
                <i class="ph ph-x"></i>
            </button>

            <img src="${imageData}" alt="${escapeAttr(imageName)}">

            <div class="image-viewer-name">
                ${escapeHTML(imageName)}
            </div>
        </div>
    `;

    viewer.addEventListener('click', function(event) {
        const clickedOutside = event.target === viewer;
        const clickedClose = event.target.closest('.image-viewer-close');

        if (clickedOutside || clickedClose) {
            viewer.remove();
        }
    });

    document.addEventListener('keydown', function closeOnEsc(event) {
        if (event.key === 'Escape') {
            viewer.remove();
            document.removeEventListener('keydown', closeOnEsc);
        }
    });

    document.body.appendChild(viewer);
}
