

(function() {
  const canvas = document.getElementById('particles-canvas');
  const ctx = canvas.getContext('2d');
  let particles = [];
  const N = 45;
  const colors = ['rgba(0,212,255,', 'rgba(168,85,247,', 'rgba(0,255,157,'];
  function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
  resize();
  window.addEventListener('resize', resize);
  function Particle() { this.x = Math.random() * canvas.width; this.y = Math.random() * canvas.height; this.size = Math.random() * 1.5 + 0.5; this.color = colors[Math.floor(Math.random() * colors.length)]; this.speed = Math.random() * 0.3 + 0.1; this.angle = Math.random() * Math.PI * 2; this.opacity = Math.random() * 0.5 + 0.1; this.pulse = Math.random() * Math.PI * 2; }
  Particle.prototype.update = function() { this.x += Math.cos(this.angle) * this.speed; this.y += Math.sin(this.angle) * this.speed; this.pulse += 0.02; this.opacity = 0.1 + Math.sin(this.pulse) * 0.1; if (this.x < 0 || this.x > canvas.width || this.y < 0 || this.y > canvas.height) { this.x = Math.random() * canvas.width; this.y = Math.random() * canvas.height; } };
  Particle.prototype.draw = function() { ctx.beginPath(); ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2); ctx.fillStyle = this.color + this.opacity + ')'; ctx.fill(); };
  for (let i = 0; i < N; i++) particles.push(new Particle());
  function animate() { ctx.clearRect(0, 0, canvas.width, canvas.height); particles.forEach(p => { p.update(); p.draw(); }); for (let i = 0; i < particles.length; i++) { for (let j = i+1; j < particles.length; j++) { const dx = particles[i].x - particles[j].x; const dy = particles[i].y - particles[j].y; const dist = Math.sqrt(dx*dx + dy*dy); if (dist < 80) { ctx.beginPath(); ctx.moveTo(particles[i].x, particles[i].y); ctx.lineTo(particles[j].x, particles[j].y); ctx.strokeStyle = `rgba(0,212,255,${0.04 * (1 - dist/80)})`; ctx.lineWidth = 0.5; ctx.stroke(); } } } requestAnimationFrame(animate); }
  animate();
})();

/* ═══════════════════════════════════════
   SUPABASE INIT (config pública em config.js)
═══════════════════════════════════════ */
const APP = window.APP_CONFIG || {};
const SUPABASE_URL = APP.SUPABASE_URL;
const SUPABASE_ANON_KEY = APP.SUPABASE_ANON_KEY;
const SUPREME_ADMIN_EMAIL = (APP.SUPREME_ADMIN_EMAIL || 'rlguilherne@gmail.com').toLowerCase();

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Defina SUPABASE_URL e SUPABASE_ANON_KEY em config.js');
}

const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ═══════════════════════════════════════
   CONFIG — sem chaves secretas (IA via Edge Functions)
═══════════════════════════════════════ */
const CONFIG = {
  providers: {
    gemini: { name: 'Gemini', icon: '✦' },
    groq:   { name: 'Groq',   icon: '⚡' },
    mistral:{ name: 'Mistral', icon: '🌪' }
  }
};

/** Chama Edge Function autenticada (chaves de IA ficam no servidor). */
async function invokeEdgeFunction(name, body, { binary = false } = {}) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session?.access_token) throw new Error('Faça login para continuar.');

  const url = `${SUPABASE_URL}/functions/v1/${name}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        apikey: SUPABASE_ANON_KEY
      },
      body: JSON.stringify(body)
    });
  } catch (networkErr) {
    console.error('Edge Function network error:', networkErr);
    throw new Error(
      'Não foi possível conectar ao servidor de IA (Failed to fetch). ' +
      'Confira no Supabase: (1) funções ai-generate e text-to-speech publicadas, ' +
      '(2) secret GEMINI_API_KEYS definido, (3) abrir o site por http/https (não abrir o .html direto do Explorer). ' +
      'Guia: SUPABASE_CONFIGURAR.md na pasta do projeto.'
    );
  }

  if (!res.ok) {
    let msg = `Erro ${res.status}`;
    try {
      const err = await res.json();
      msg = err.error || err.message || msg;
    } catch (_) { /* resposta não-JSON */ }
    if (res.status === 404) {
      msg = `Função "${name}" não encontrada. Faça deploy da Edge Function no Supabase (veja SUPABASE_CONFIGURAR.md).`;
    }
    throw new Error(msg);
  }
  return binary ? res : res.json();
}

/* ═══════════════════════════════════════
   STATE
═══════════════════════════════════════ */
let state = {
  messages: [], currentSubject: 'geral', currentMode: 'divertido',
  currentProvider: 'gemini',
  isLoading: false, isSpeaking: false, isListening: false,
  recognition: null, currentAudio: null, currentView: 'chat', attachedPDF: null,
  gamification: { totalMsgs: 0, quizzesCompleted: 0, quizScores: [], subjectCounts: {}, streak: 0, weeklyActivity: [0,0,0,0,0,0,0], lastActiveDay: '', weekStart: '' }
};
let currentUser = null;
let chatHistory = [];
let modoAulaAtivo = null; // { materia, serie, turma } ou null
let aulaAtivaId = null;   // id do registro em aulas_ativas da aula em andamento
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/* ═══════════════════════════════════════
   DB LAYER — Supabase only, no localStorage for data
═══════════════════════════════════════ */
const DB = {
  /* ── users ── */
  async getUser(uid) {
    try {
      const { data, error } = await sb.from('users').select('*').eq('id', uid).single();
      if (error || !data) return null;
      return data;
    } catch(e) { console.warn('DB.getUser', e); return null; }
  },

  async upsertUser(uid, payload) {
    try {
      const { error } = await sb.from('users').upsert(
        { id: uid, ...payload, updated_at: new Date().toISOString() },
        { onConflict: 'id' }
      );
      if (error) console.warn('DB.upsertUser error:', error.message, '| Código:', error.code);
    } catch(e) { console.warn('DB.upsertUser exception:', e); }
  },

  async getAllUsers() {
    try {
      // Tenta buscar todos (requer RLS policy: admins podem ler todos)
      const { data, error } = await sb.from('users').select('*').order('created_at', { ascending: false });
      if (error) {
        console.warn('DB.getAllUsers error:', error.message, '| Código:', error.code);
        // Fallback: RLS bloqueou — retorna pelo menos o usuário atual
        if (currentUser?.id) {
          const { data: me } = await sb.from('users').select('*').eq('id', currentUser.id).single();
          return me ? [me] : [];
        }
        return [];
      }
      return data || [];
    } catch(e) { console.warn('DB.getAllUsers exception:', e); return []; }
  },

  async isAdmin(uid) {
    try {
      const { data } = await sb.from('users').select('is_admin, email').eq('id', uid).single();
      if (!data) return false;
      if ((data.email || '').toLowerCase() === SUPREME_ADMIN_EMAIL) return true;
      return data.is_admin === true;
    } catch(e) { return false; }
  },

  /* ── chat history ── */
  async saveChatSession(uid, subject, mode, messages) {
    try {
      const preview = messages.find(m => m.role === 'user')?.parts[0]?.text?.substring(0, 80) || 'Chat';
      const payload = { user_id: uid, subject, mode, messages: JSON.stringify(messages), preview, created_at: new Date().toISOString() };
      const { data, error } = await sb.from('chat_history').insert(payload).select('id').single();
      if (error) console.warn('DB.saveChatSession', error);
      return data?.id || null;
    } catch(e) { console.warn('DB.saveChatSession', e); return null; }
  },

  async updateChatSession(id, messages) {
    try {
      const { error } = await sb.from('chat_history').update({ messages: JSON.stringify(messages) }).eq('id', id);
      if (error) { console.warn('DB.updateChatSession', error); return false; }
      return true;
    } catch(e) { console.warn('DB.updateChatSession', e); return false; }
  },

  async getChatHistory(uid, limit = 20) {
    try {
      const { data } = await sb.from('chat_history').select('id, subject, mode, preview, created_at').eq('user_id', uid).order('created_at', { ascending: false }).limit(limit);
      return data || [];
    } catch(e) { return []; }
  },

  async getChatSession(id) {
    try {
      const { data } = await sb.from('chat_history').select('*').eq('id', id).single();
      if (!data) return null;
      return { ...data, messages: JSON.parse(data.messages || '[]') };
    } catch(e) { return null; }
  },

  /* ── quiz history ── */
  async saveQuizResult(uid, subject, score, total) {
    try {
      const { data, error } = await sb.from('quiz_history')
        .insert({ user_id: uid, subject, score, total, accuracy: total ? score/total : 0, created_at: new Date().toISOString() })
        .select('id').single();
      if (error) console.warn('DB.saveQuizResult', error);
      return data?.id || null;
    } catch(e) { console.warn('DB.saveQuizResult', e); return null; }
  },

  /** Atualiza o registro original do quiz com o resultado real. */
  async updateQuizResult(id, score, total) {
    try {
      const { error } = await sb.from('quiz_history')
        .update({ score, total, accuracy: total ? score/total : 0 }).eq('id', id);
      if (error) { console.warn('DB.updateQuizResult', error); return false; }
      return true;
    } catch(e) { console.warn('DB.updateQuizResult', e); return false; }
  },

  /* ── analytics ── */
  async logActivity(uid, type, detail = '') {
    try {
      await sb.from('analytics').insert({ user_id: uid, type, detail, created_at: new Date().toISOString() });
    } catch(e) { /* silent */ }
  },

  async getAnalytics(limit = 100) {
    try {
      const { data } = await sb.from('analytics').select('*, users(name, email)').order('created_at', { ascending: false }).limit(limit);
      return data || [];
    } catch(e) { return []; }
  },

  /* ── gamification ── */
  async saveGamification(uid, gam) {
    try {
      await sb.from('users').update({ gamification: gam }).eq('id', uid);
    } catch(e) { console.warn('DB.saveGamification', e); }
  }
};

/* ═══════════════════════════════════════
   AUTH ENGINE — Supabase Auth only
═══════════════════════════════════════ */
function setAuthLoading(on, msg = 'Verificando sessão...') {
  const overlay = document.getElementById('authLoadingOverlay');
  if (!overlay) return;
  const text = overlay.querySelector('.auth-loading-text');
  if (text) text.textContent = msg;
  // Usa .active + remove style.display inline (Fix mobile touch-blocking)
  overlay.style.display = '';
  if (on) {
    overlay.classList.add('active');
  } else {
    overlay.classList.remove('active');
    // Força remoção de qualquer display inline residual
    overlay.style.cssText = '';
  }
}

async function doRegister() {
  const tipoConta = document.getElementById('regTipoConta')?.value || 'aluno';
  const name  = document.getElementById('regName').value.trim();
  const email = document.getElementById('regEmail').value.trim().toLowerCase();
  const pass  = document.getElementById('regPassword').value;
  const errEl = document.getElementById('registerError');
  const sucEl = document.getElementById('registerSuccess');
  const btn   = document.getElementById('registerBtn');

  // Campos específicos por tipo
  const serie   = tipoConta === 'aluno' ? (document.getElementById('regSerie')?.value || '') : '';
  const turma   = tipoConta === 'aluno' ? (document.getElementById('regTurma')?.value || '') : '';
  const materia = tipoConta === 'professor' ? (document.getElementById('regMateria')?.value || '') : '';
  const codigoProf = tipoConta === 'professor' ? (document.getElementById('regCodigoProf')?.value || '').trim() : '';

  errEl.classList.remove('show'); sucEl.classList.remove('show');
  if (!name) { errEl.textContent = 'Informe seu nome.'; errEl.classList.add('show'); return; }
  if (!email || !email.includes('@')) { errEl.textContent = 'E-mail inválido.'; errEl.classList.add('show'); return; }
  if (pass.length < 6) { errEl.textContent = 'Senha deve ter pelo menos 6 caracteres.'; errEl.classList.add('show'); return; }
  if (tipoConta === 'professor' && !materia) {
    errEl.textContent = 'Professores devem selecionar a matéria.';
    errEl.classList.add('show');
    return;
  }
  if (tipoConta === 'professor' && codigoProf !== 'PROJP2026') {
    errEl.textContent = '❌ Código de acesso inválido. Solicite o código à direção da escola.';
    errEl.classList.add('show');
    return;
  }

  btn.disabled = true; btn.textContent = 'Criando conta...';
  try {
    const { data, error } = await sb.auth.signUp({
      email,
      password: pass,
      options: {
        data: {
          full_name: name,
          tipo_conta: tipoConta,
          materia: materia || null,
          serie: serie || null,
          turma: turma || null
        }
      }
    });
    if (error) { errEl.textContent = translateAuthError(error.message); errEl.classList.add('show'); return; }

    const uid = data.user?.id;
    if (uid) {
      const isSupreme = email === SUPREME_ADMIN_EMAIL;
      await DB.upsertUser(uid, {
        name,
        email,
        tipo_conta: isSupreme ? 'super_admin' : tipoConta,
        serie,
        turma,
        materia,
        banned: false,
        gamification: state.gamification,
        created_at: new Date().toISOString()
      });
      await DB.logActivity(uid, 'register', `Cadastro: ${name} (${isSupreme ? 'super_admin' : tipoConta})`);
    }

    if (data.session) {
      await onUserLoggedIn(data.user);
    } else {
      const tipoMsg = tipoConta === 'professor'
        ? ' Conta de professor criada — após confirmar o e-mail, use Entrar com a mesma senha.'
        : '';
      sucEl.textContent = `✅ Conta criada! Verifique seu e-mail para confirmar.${tipoMsg}`;
      sucEl.classList.add('show');
    }
  } catch(e) {
    errEl.textContent = e.message;
    errEl.classList.add('show');
  } finally {
    btn.disabled = false; btn.textContent = 'Criar conta →';
  }
}

async function doLogin() {
  const email = document.getElementById('loginEmail').value.trim().toLowerCase();
  const pass  = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  const btn   = document.getElementById('loginBtn');

  errEl.classList.remove('show');
  if (!email || !pass) { errEl.textContent = 'Preencha e-mail e senha.'; errEl.classList.add('show'); return; }

  btn.disabled = true; btn.textContent = 'Entrando...';
  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password: pass });
    if (error) { errEl.textContent = translateAuthError(error.message); errEl.classList.add('show'); return; }
    await onUserLoggedIn(data.user);
  } catch(e) {
    errEl.textContent = e.message; errEl.classList.add('show');
  } finally {
    btn.disabled = false; btn.textContent = 'Entrar →';
  }
}

async function doGoogleLogin() {
  try {
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.href }
    });
    if (error) { showToast('❌ ' + error.message, 'error'); setTimeout(hideToast, 3000); }
  } catch(e) {
    showToast('❌ Google login falhou. Use e-mail/senha.', 'error');
    setTimeout(hideToast, 3000);
  }
}

async function doForgotPassword() {
  const email = document.getElementById('forgotEmail').value.trim().toLowerCase();
  const errEl = document.getElementById('forgotError');
  const sucEl = document.getElementById('forgotSuccess');
  const btn   = document.getElementById('forgotBtn');

  errEl.classList.remove('show'); sucEl.classList.remove('show');
  if (!email) { errEl.textContent = 'Informe o e-mail.'; errEl.classList.add('show'); return; }

  btn.disabled = true; btn.textContent = 'Enviando...';
  try {
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.href });
    if (error) { errEl.textContent = translateAuthError(error.message); errEl.classList.add('show'); }
    else { sucEl.textContent = '✅ Link enviado! Verifique seu e-mail.'; sucEl.classList.add('show'); }
  } catch(e) {
    errEl.textContent = e.message; errEl.classList.add('show');
  } finally {
    btn.disabled = false; btn.textContent = 'Enviar link →';
  }
}

async function doLogout() {
  if (currentUser) {
    if (modoAulaAtivo) await desativarModoAula(true);
    await saveActiveSession();
    await DB.saveGamification(currentUser.id, state.gamification);
    await DB.logActivity(currentUser.id, 'logout', `Logout: ${currentUser.email}`);
  }
  toggleUserDropdown(false);
  await sb.auth.signOut();
  onUserLoggedOut();
}

function translateAuthError(msg) {
  if (msg.includes('Invalid login credentials')) return 'E-mail ou senha incorretos.';
  if (msg.includes('Email not confirmed')) return 'Confirme seu e-mail antes de entrar.';
  if (msg.includes('User already registered')) return 'Este e-mail já está cadastrado.';
  if (msg.includes('Password should be')) return 'Senha deve ter pelo menos 6 caracteres.';
  if (msg.includes('Unable to validate email')) return 'E-mail inválido.';
  return msg;
}

function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('loginForm').classList.toggle('hidden', tab !== 'login');
  document.getElementById('registerForm').classList.toggle('hidden', tab !== 'register');
  document.getElementById('forgotForm').classList.toggle('hidden', tab !== 'forgot');
  if (tab === 'register') toggleRegFields();
}

/* ─── ON LOGGED IN ─── */
async function onUserLoggedIn(authUser) {
  setAuthLoading(true, 'Carregando perfil...');

  // Hard timeout: se travar por mais de 8s, libera
  const hardTimeout = setTimeout(() => {
    console.warn('⚠️ onUserLoggedIn timeout — liberando app');
    // Login de emergência sem perfil completo
    currentUser = { id: authUser.id, email: authUser.email, name: authUser.email.split('@')[0], is_admin: authUser.email === SUPREME_ADMIN_EMAIL };
    updateUserUI();
    document.getElementById('auth-screen').classList.add('hidden');
    setAuthLoading(false);
    showToast('⚠️ Perfil carregado em modo básico — verifique o Supabase', 'error');
    setTimeout(hideToast, 5000);
  }, 8000);

  try {
    // Tenta buscar perfil do banco
    let profile = null;
    try { profile = await DB.getUser(authUser.id); } catch(e) { console.warn('getUser failed:', e); }

    if (!profile) {
      const meta = authUser.user_metadata || {};
      const tipoFromMeta = meta.tipo_conta === 'professor' ? 'professor' : 'aluno';
      const isSupreme = (authUser.email || '').toLowerCase() === SUPREME_ADMIN_EMAIL;
      try {
        await DB.upsertUser(authUser.id, {
          name: meta.full_name || authUser.email.split('@')[0],
          email: authUser.email,
          tipo_conta: isSupreme ? 'super_admin' : tipoFromMeta,
          materia: meta.materia || '',
          serie: meta.serie || '',
          turma: meta.turma || '',
          banned: false,
          gamification: {},
          created_at: new Date().toISOString()
        });
        profile = await DB.getUser(authUser.id);
      } catch(e) {
        console.warn('upsertUser failed (tabela users pode não existir ainda):', e);
        profile = {
          id: authUser.id,
          name: authUser.email.split('@')[0],
          email: authUser.email,
          is_admin: isSupreme,
          tipo_conta: isSupreme ? 'super_admin' : tipoFromMeta,
          banned: false
        };
      }
    } else {
      // Usuário já existe: atualiza last_seen para sincronização entre dispositivos
      // Não bloqueia login se falhar
      try {
        await sb.from('users')
          .update({ last_seen: new Date().toISOString() })
          .eq('id', authUser.id);
      } catch(e) { /* silencioso — last_seen pode não existir ainda */ }
    }

    // Conta banida
    if (profile?.banned) {
      clearTimeout(hardTimeout);
      await sb.auth.signOut();
      setAuthLoading(false);
      const errEl = document.getElementById('loginError');
      if (errEl) { errEl.textContent = '⛔ Sua conta foi banida. Contate o administrador.'; errEl.classList.add('show'); }
      return;
    }

    // Monta currentUser com campos explícitos — nunca deixa authUser sobrescrever profile
    currentUser = {
      id:         authUser.id,
      email:      authUser.email,
      name:       profile?.name     || authUser.user_metadata?.full_name || authUser.email.split('@')[0],
      is_admin:   profile?.is_admin === true || (authUser.email || '').toLowerCase() === SUPREME_ADMIN_EMAIL,
      banned:     profile?.banned   === true,
      gamification: profile?.gamification || {},
      created_at:   profile?.created_at   || null,
      // Novos campos de perfil
      tipo_conta: profile?.tipo_conta || ((authUser.email || '').toLowerCase() === SUPREME_ADMIN_EMAIL ? 'super_admin' : 'aluno'),
      serie:      profile?.serie   || '',
      turma:      profile?.turma   || '',
      materia:    profile?.materia || '',
    };
    console.log('✅ currentUser montado:', currentUser.email, '| tipo_conta:', currentUser.tipo_conta);

    // Gamification
    if (profile?.gamification && Object.keys(profile.gamification).length) {
      state.gamification = { ...state.gamification, ...profile.gamification };
    }
    normalizeGamification();

    // Log e UI (não críticos — não bloqueiam o login se falharem)
    try { await DB.logActivity(authUser.id, 'login', 'Login: ' + authUser.email); } catch(e) {}
    updateGamificationUI();
    updateUserUI();
    try { loadChatHistory(); } catch(e) {}

    document.getElementById('auth-screen').classList.add('hidden');
  } catch(e) {
    console.error('onUserLoggedIn error:', e);
    // Em caso de erro grave, faz login básico para não travar
    currentUser = {
      id:       authUser.id,
      email:    authUser.email,
      name:     authUser.user_metadata?.full_name || authUser.email.split('@')[0],
      is_admin: authUser.email === SUPREME_ADMIN_EMAIL,
      banned:   false,
    };
    console.warn('⚠️ Login emergência — is_admin:', currentUser.is_admin);
    updateUserUI();
    document.getElementById('auth-screen').classList.add('hidden');
  } finally {
    clearTimeout(hardTimeout);
    setAuthLoading(false);
  }
}

function onUserLoggedOut() {
  currentUser = null;
  state.gamification = { totalMsgs: 0, quizzesCompleted: 0, quizScores: [], subjectCounts: {}, streak: 0, weeklyActivity: [0,0,0,0,0,0,0], lastActiveDay: '', weekStart: '' };
  state.messages = [];
  chatHistory = [];
  sessionRef = { id: null };
  _sessionSaveChain = Promise.resolve();
  document.getElementById('auth-screen').classList.remove('hidden');
  updateGamificationUI();
}

function updateUserUI() {
  if (!currentUser) return;
  const name = currentUser.name || currentUser.email?.split('@')[0] || '?';
  const initials = name.charAt(0).toUpperCase();
  document.getElementById('userAvatarBtn').textContent = initials;
  document.getElementById('dropdownName').textContent = name;
  document.getElementById('dropdownEmail').textContent = currentUser.email || '';

  const tipo = currentUser.tipo_conta || 'aluno';
  const isAdmin = currentUser.is_admin === true || currentUser.email === SUPREME_ADMIN_EMAIL;
  const isSuperAdmin = tipo === 'super_admin' || currentUser.email === SUPREME_ADMIN_EMAIL;
  const isProf = tipo === 'professor';

  const adminBtn      = document.getElementById('adminPanelBtn');
  const profBtn       = document.getElementById('professorPanelBtn');
  const superAdminBtn = document.getElementById('superAdminPanelBtn');

  if (adminBtn)      adminBtn.style.display      = isAdmin ? 'flex' : 'none';
  if (profBtn)       profBtn.style.display        = isProf  ? 'flex' : 'none';
  if (superAdminBtn) superAdminBtn.style.display  = isSuperAdmin ? 'flex' : 'none';

  // Sincroniza UI do administrador supremo (privilégios garantidos pelo trigger SQL)
  if ((currentUser.email || '').toLowerCase() === SUPREME_ADMIN_EMAIL) {
    currentUser.is_admin = true;
    currentUser.tipo_conta = 'super_admin';
  }

  // Carrega avisos para alunos
  if (tipo === 'aluno') {
    loadAvisosAluno();
  }
}

/* ═══════════════════════════════════════
   SUPABASE AUTH STATE LISTENER
═══════════════════════════════════════ */
/* ═══════════════════════════════════════
   AUTH STATE LISTENER
═══════════════════════════════════════ */
sb.auth.onAuthStateChange(async (event, session) => {
  if (event === 'PASSWORD_RECOVERY') {
    showToast('🔑 Agora defina sua nova senha', 'success');
  }
  // SIGNED_IN / SIGNED_OUT são tratados pelo init() e pelas funções de login/logout
  // para evitar chamadas duplicadas
});

/* ═══════════════════════════════════════
   INIT — Verifica sessão existente
   Timeout de 6s para não travar infinito
═══════════════════════════════════════ */
(async function init() {
  setAuthLoading(true, 'Conectando ao servidor...');

  // Safety timeout — se o Supabase não responder em 6s, libera a tela
  const timeout = setTimeout(() => {
    console.warn('⚠️ Supabase demorou demais — liberando tela de login');
    setAuthLoading(false);
    renderWelcome();
  }, 6000);

  try {
    const { data: { session }, error } = await sb.auth.getSession();
    clearTimeout(timeout);

    if (error) {
      console.warn('Supabase getSession error:', error.message);
      setAuthLoading(false);
      renderWelcome();
      return;
    }

    if (session?.user) {
      setAuthLoading(true, 'Carregando seu perfil...');
      await onUserLoggedIn(session.user);
    } else {
      // Nenhuma sessão ativa → mostra tela de login
      setAuthLoading(false);
    }
    renderWelcome();
  } catch(e) {
    clearTimeout(timeout);
    console.warn('Init error:', e);
    setAuthLoading(false);
    renderWelcome();
  }
})();

/* ═══════════════════════════════════════
   GAMIFICATION
═══════════════════════════════════════ */
const ACHIEVEMENTS = [
  { id: 'first_msg',    icon: '🌟', name: 'Primeira Pergunta', cond: g => g.totalMsgs >= 1 },
  { id: 'five_msgs',    icon: '🔥', name: '5 Perguntas',        cond: g => g.totalMsgs >= 5 },
  { id: 'twenty_msgs',  icon: '💪', name: '20 Perguntas',       cond: g => g.totalMsgs >= 20 },
  { id: 'fifty_msgs',   icon: '🚀', name: '50 Perguntas',       cond: g => g.totalMsgs >= 50 },
  { id: 'first_quiz',   icon: '🎯', name: 'Primeiro Quiz',      cond: g => g.quizzesCompleted >= 1 },
  { id: 'five_quizzes', icon: '🏆', name: '5 Quizzes',          cond: g => g.quizzesCompleted >= 5 },
  { id: 'multi_sub',    icon: '📚', name: 'Multi-Matéria',       cond: g => Object.keys(g.subjectCounts).length >= 3 },
  { id: 'ace_quiz',     icon: '💯', name: 'Nota 100%',           cond: g => g.quizScores.some(s => s === 1) }
];
const LEVEL_THRESHOLDS = [0,5,15,30,50,80,120,180,250,350];

function getLevel(msgs) {
  let lvl = 1;
  for (let i = 0; i < LEVEL_THRESHOLDS.length; i++) { if (msgs >= LEVEL_THRESHOLDS[i]) lvl = i+1; }
  return Math.min(lvl, 10);
}

function updateGamificationUI() {
  const g = normalizeGamification();
  const level = getLevel(g.totalMsgs);
  const nextThresh = LEVEL_THRESHOLDS[level] || 999;
  const prevThresh = LEVEL_THRESHOLDS[level-1] || 0;
  const pct = Math.min(100, ((g.totalMsgs - prevThresh) / (nextThresh - prevThresh)) * 100);
  document.getElementById('xpLevel').textContent = `Nível ${level}`;
  document.getElementById('xpFill').style.width = pct + '%';
  document.getElementById('statMsgs').textContent = g.totalMsgs;
  document.getElementById('statQuizzes').textContent = g.quizzesCompleted;
  document.getElementById('statStreak').textContent = g.streak;
}

async function updateDashboard() {
  const g = normalizeGamification();
  const todayIdx = weekdayIndex();

  // Dados locais (rápidos)
  document.getElementById('dashTotalMsgs').textContent = g.totalMsgs;
  document.getElementById('dashMsgTrend').textContent = `+${g.weeklyActivity[todayIdx] || 0} hoje`;
  document.getElementById('dashQuizCount').textContent = g.quizzesCompleted;
  if (g.quizScores.length > 0) {
    const avg = g.quizScores.reduce((a,b)=>a+b,0)/g.quizScores.length;
    document.getElementById('dashQuizAcc').textContent = `Média: ${Math.round(avg*100)}%`;
  } else {
    document.getElementById('dashQuizAcc').textContent = '— sem quizzes ainda';
  }

  // Gráfico de atividade semanal
  const days = ['Seg','Ter','Qua','Qui','Sex','Sáb','Dom'];
  const maxVal = Math.max(...g.weeklyActivity, 1);
  document.getElementById('activityBars').innerHTML = g.weeklyActivity.map((v, i) => {
    const h = Math.max(4, Math.round((v/maxVal)*46));
    return `<div class="mini-bar${i===todayIdx?' today':''}" style="height:${h}px" title="${v} msgs"><span class="mini-bar-label">${days[i]}</span></div>`;
  }).join('');

  // Achievements
  document.getElementById('achievementsGrid').innerHTML = ACHIEVEMENTS.map(a => {
    const unlocked = a.cond(g);
    return `<div class="achievement${unlocked?' unlocked':''}" title="${a.name}"><div class="achievement-icon">${a.icon}</div><div class="achievement-name">${a.name}</div></div>`;
  }).join('');

  // Carrega dados reais do Supabase em paralelo
  if (currentUser) {
    try {
      // Busca analytics para matérias favoritas reais
      const [analyticsRes, quizRes] = await Promise.all([
        sb.from('analytics').select('detail, created_at').eq('user_id', currentUser.id).eq('type', 'message').order('created_at', { ascending: false }).limit(200),
        sb.from('quiz_history').select('subject, score, total, accuracy, created_at').eq('user_id', currentUser.id).order('created_at', { ascending: false }).limit(50)
      ]);

      // Conta matérias reais dos logs
      const subjectEmojis = {geral:'✨',matematica:'📐',fisica:'⚛️',quimica:'🧪',biologia:'🌿',historia:'🏛️',geografia:'🌍',portugues:'📝',ingles:'🇬🇧',filosofia:'🤔',sociologia:'👥',enem:'🎯'};
      const subColors = ['#00d4ff','#00ff9d','#a855f7','#fbbf24','#f472b6','#fb923c'];

      // Mescla subjectCounts do gamification com analytics reais
      const realCounts = { ...g.subjectCounts };
      (analyticsRes.data || []).forEach(row => {
        const match = row.detail?.match(/em (\w+)/);
        if (match) { realCounts[match[1]] = (realCounts[match[1]] || 0) + 1; }
      });

      const subEntries = Object.entries(realCounts).sort((a,b)=>b[1]-a[1]).slice(0,6);
      const total = subEntries.reduce((s,[,v])=>s+v,0) || 1;

      document.getElementById('subjectProgressList').innerHTML = subEntries.length
        ? subEntries.map(([sub,cnt],i) => {
            const pct = Math.round((cnt/total)*100);
            return `<div class="subject-progress-item"><div class="subject-progress-header"><span class="subject-progress-name">${subjectEmojis[sub]||'📖'} ${sub}</span><span class="subject-progress-pct">${pct}%</span></div><div class="subject-progress-bar"><div class="subject-progress-fill" style="width:${pct}%;background:${subColors[i%subColors.length]}"></div></div></div>`;
          }).join('')
        : '<div style="color:var(--text-muted);font-size:12px">Comece a conversar para ver suas matérias favoritas! 💬</div>';

      // Quizzes reais do banco
      const quizData = quizRes.data || [];
      if (quizData.length > 0) {
        const realTotal = quizData.length;
        const avgAcc = quizData.reduce((s,q)=>s+(q.accuracy||0),0)/realTotal;
        document.getElementById('dashQuizCount').textContent = realTotal;
        document.getElementById('dashQuizAcc').textContent = `Média: ${Math.round(avgAcc*100)}%`;
      }

      // Atividade semanal real (últimos 7 dias)
      const weekCounts = [0,0,0,0,0,0,0];
      const dayOfWeek = todayIdx; // 0=Seg...6=Dom
      const weekStartDate = keyToDate(weekStartKey());
      (analyticsRes.data || []).forEach(row => {
        const d = new Date(row.created_at);
        if (d >= weekStartDate) weekCounts[weekdayIndex(d)]++;   // só a semana corrente, por dia de calendário
      });
      // Mescla com weeklyActivity local
      const mergedWeek = weekCounts.map((v,i) => Math.max(v, g.weeklyActivity[i]||0));
      const maxW = Math.max(...mergedWeek, 1);
      document.getElementById('activityBars').innerHTML = mergedWeek.map((v, i) => {
        const h = Math.max(4, Math.round((v/maxW)*46));
        return `<div class="mini-bar${i===dayOfWeek?' today':''}" style="height:${h}px" title="${v} atividades"><span class="mini-bar-label">${days[i]}</span></div>`;
      }).join('');

    } catch(e) {
      console.warn('Dashboard Supabase load:', e);
      // Fallback para dados locais
      const subjectEmojis = {geral:'✨',matematica:'📐',fisica:'⚛️',quimica:'🧪',biologia:'🌿',historia:'🏛️',geografia:'🌍',portugues:'📝',ingles:'🇬🇧',filosofia:'🤔',sociologia:'👥',enem:'🎯'};
      const subColors = ['#00d4ff','#00ff9d','#a855f7','#fbbf24','#f472b6','#fb923c'];
      const subEntries = Object.entries(g.subjectCounts).sort((a,b)=>b[1]-a[1]).slice(0,5);
      const total = subEntries.reduce((s,[,v])=>s+v,0) || 1;
      document.getElementById('subjectProgressList').innerHTML = subEntries.length
        ? subEntries.map(([sub,cnt],i) => {
            const pct = Math.round((cnt/total)*100);
            return `<div class="subject-progress-item"><div class="subject-progress-header"><span class="subject-progress-name">${subjectEmojis[sub]||'📖'} ${sub}</span><span class="subject-progress-pct">${pct}%</span></div><div class="subject-progress-bar"><div class="subject-progress-fill" style="width:${pct}%;background:${subColors[i%subColors.length]}"></div></div></div>`;
          }).join('')
        : '<div style="color:var(--text-muted);font-size:12px">Comece a conversar para ver suas matérias favoritas!</div>';
    }
  } else {
    document.getElementById('subjectProgressList').innerHTML = '<div style="color:var(--text-muted);font-size:12px">Faça login para ver suas estatísticas</div>';
  }

  // Recomendações inteligentes
  const recos = [];
  if (g.totalMsgs < 5) recos.push({icon:'💬',title:'Faça sua primeira pergunta',sub:'Experimente perguntar sobre qualquer matéria',action:'chat'});
  if (g.quizzesCompleted < 3) recos.push({icon:'🎯',title:'Treine com quizzes',sub:'Teste seus conhecimentos com IA',action:'quiz'});
  const subjects = Object.keys(g.subjectCounts);
  if (!subjects.includes('matematica')) recos.push({icon:'📐',title:'Explore Matemática',sub:'Ainda não interagiu com essa matéria',action:'chat'});
  if (!subjects.includes('historia')) recos.push({icon:'🏛️',title:'Explore História',sub:'Ainda não interagiu com essa matéria',action:'chat'});
  recos.push({icon:'📅',title:'Monte seu plano de estudos',sub:'A IA cria um cronograma personalizado',action:'plan'});
  recos.push({icon:'📄',title:'Envie um PDF para análise',sub:'Resumo e quiz automáticos',action:'upload'});
  document.getElementById('recoList').innerHTML = recos.slice(0,4).map(r =>
    `<div class="reco-item" onclick="setView('${r.action}')"><div class="reco-icon">${r.icon}</div><div class="reco-text"><div class="reco-title">${r.title}</div><div class="reco-sub">${r.sub}</div></div><div class="reco-arrow">→</div></div>`
  ).join('');
}

/* ── Datas (fuso local) ── */
function dayKey(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function keyToDate(k) { const [y,m,d] = k.split('-').map(Number); return new Date(y, m-1, d); }
/** Aceita 'YYYY-MM-DD' ou formatos antigos (ex.: Date.toDateString()). */
function normalizeDayKey(v) {
  if (!v) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(v);
  return isNaN(d) ? '' : dayKey(d);
}
function weekdayIndex(d = new Date()) { return (d.getDay() + 6) % 7; } // 0=Seg … 6=Dom
function weekStartKey(d = new Date()) {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate() - weekdayIndex(d));
  return dayKey(m);
}
function daysBetween(aKey, bKey) {
  return Math.round((keyToDate(bKey) - keyToDate(aKey)) / 86400000);
}

/** Zera a semana quando virou e quebra a sequência se passou mais de 1 dia sem atividade. */
function normalizeGamification(g = state.gamification) {
  if (!Array.isArray(g.weeklyActivity) || g.weeklyActivity.length !== 7) g.weeklyActivity = [0,0,0,0,0,0,0];
  const wk = weekStartKey();
  if (g.weekStart !== wk) { g.weeklyActivity = [0,0,0,0,0,0,0]; g.weekStart = wk; }
  g.lastActiveDay = normalizeDayKey(g.lastActiveDay);
  if (g.lastActiveDay && daysBetween(g.lastActiveDay, dayKey()) > 1) g.streak = 0;
  return g;
}

/** Registra atividade no dia de hoje: streak = dias CONSECUTIVOS com atividade. */
function touchStreak() {
  const g = normalizeGamification();
  const today = dayKey();
  if (g.lastActiveDay === today) return;
  g.streak = (g.lastActiveDay && daysBetween(g.lastActiveDay, today) === 1) ? (g.streak || 0) + 1 : 1;
  g.lastActiveDay = today;
}

function trackMsg(subject) {
  const g = normalizeGamification();
  g.totalMsgs++;
  g.weeklyActivity[weekdayIndex()] = (g.weeklyActivity[weekdayIndex()] || 0) + 1;
  if (!g.subjectCounts[subject]) g.subjectCounts[subject] = 0;
  g.subjectCounts[subject]++;
  touchStreak();
  updateGamificationUI();
  if (state.gamification.totalMsgs % 5 === 0 && currentUser) {
    DB.saveGamification(currentUser.id, state.gamification);
  }
}

/* ═══════════════════════════════════════
   VIEW SWITCHING
═══════════════════════════════════════ */
const VIEW_LABELS = { chat:'Chat IA', dashboard:'Dashboard', quiz:'Quiz IA', plan:'Plano de Estudos', upload:'PDF + IA', 'atividades-aluno':'Atividades', 'avisos-aluno':'Avisos' };
function setView(v) {
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.getElementById('view-'+v).classList.add('active');
  const navEl = document.getElementById('nav-'+v);
  if (navEl) navEl.classList.add('active');
  document.getElementById('viewLabel').textContent = VIEW_LABELS[v] || v;
  document.getElementById('subjectsBar').style.display = v === 'chat' ? 'flex' : 'none';
  state.currentView = v;
  if (v === 'dashboard') updateDashboard();
  if (v === 'atividades-aluno') loadAtividadesAluno();
  if (isMobile) closeSidebar();
}

/* ═══════════════════════════════════════
   SIDEBAR
═══════════════════════════════════════ */
function toggleSidebar() { document.getElementById('sidebar').classList.toggle('open'); document.getElementById('sidebarOverlay').classList.toggle('show'); }
function closeSidebar() { document.getElementById('sidebar').classList.remove('open'); document.getElementById('sidebarOverlay').classList.remove('show'); }

function toggleAdminNav(screenId = 'admin-screen') {
  const screen = document.getElementById(screenId);
  if (!screen) return;
  const nav = screen.querySelector('.admin-nav');
  const overlay = screen.querySelector('.admin-nav-overlay');
  nav?.classList.toggle('open');
  overlay?.classList.toggle('show');
}

function closeAdminNav(screenId = 'admin-screen') {
  const screen = document.getElementById(screenId);
  if (!screen) return;
  screen.querySelector('.admin-nav')?.classList.remove('open');
  screen.querySelector('.admin-nav-overlay')?.classList.remove('show');
}

/* ═══════════════════════════════════════
   USER DROPDOWN
═══════════════════════════════════════ */
function toggleUserDropdown(force) {
  const dd = document.getElementById('userDropdown');
  const show = force !== undefined ? force : !dd.classList.contains('open');
  dd.classList.toggle('open', show);
}
document.addEventListener('click', e => {
  if (!e.target.closest('#userDropdown') && !e.target.closest('#userAvatarBtn')) toggleUserDropdown(false);
  if (!e.target.closest('#adminUserModal') && e.target === document.getElementById('adminUserModal')) closeAdminUserModal();
});

/* ═══════════════════════════════════════
   HISTORY
═══════════════════════════════════════ */
async function loadChatHistory() {
  if (!currentUser) return;
  chatHistory = await DB.getChatHistory(currentUser.id, 30);
  renderHistoryList();
}

function renderHistoryList() {
  const list = document.getElementById('historyList');
  if (!chatHistory.length) { list.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:32px;font-size:13px">Nenhum histórico ainda</div>'; return; }
  const subjectEmojis = {geral:'✨',matematica:'📐',fisica:'⚛️',quimica:'🧪',biologia:'🌿',historia:'🏛️',geografia:'🌍',portugues:'📝',ingles:'🇬🇧',filosofia:'🤔',sociologia:'👥',enem:'🎯'};
  list.innerHTML = chatHistory.map(h => `
    <div class="history-item" onclick="loadChatSession('${h.id}')">
      <div class="history-item-title">${esc(h.preview || 'Conversa')}</div>
      <div class="history-item-meta">
        <span>${subjectEmojis[h.subject]||'📖'} ${h.subject||'geral'}</span>
        <span>${new Date(h.created_at).toLocaleDateString('pt-BR')}</span>
      </div>
    </div>`).join('');
}

function toggleHistory() {
  document.getElementById('historyPanel').classList.toggle('open');
  if (isMobile) closeSidebar();
}

async function loadChatSession(id) {
  const session = await DB.getChatSession(id);
  if (!session) return;
  sessionRef = { id };
  state.messages = session.messages || [];
  state.currentSubject = session.subject || 'geral';
  state.currentMode = session.mode || 'divertido';
  document.getElementById('chat').innerHTML = '';
  state.messages.forEach(m => appendMsg(m.role === 'model' ? 'ai' : 'user', m.parts[0].text));
  setView('chat');
  toggleHistory();
}

let sessionRef = { id: null };          // conversa atual (id no banco, quando já salva)
let _sessionSaveChain = Promise.resolve();
/**
 * Salva a conversa atual: cria o registro na primeira vez e, depois,
 * ATUALIZA o mesmo registro a cada nova mensagem. As gravações são
 * enfileiradas e presas à conversa que as originou (evita duplicatas
 * e sobrescrita ao limpar o chat ou trocar de modelo).
 */
function saveActiveSession() {
  if (!currentUser || !state.messages.length) return Promise.resolve();
  const ref = sessionRef;
  const uid = currentUser.id;
  const subject = state.currentSubject;
  const mode = state.currentMode;
  const messages = JSON.parse(JSON.stringify(state.messages));
  _sessionSaveChain = _sessionSaveChain.then(async () => {
    try {
      if (ref.id) {
        await DB.updateChatSession(ref.id, messages);
      } else {
        ref.id = await DB.saveChatSession(uid, subject, mode, messages);
        if (ref.id) await loadChatHistory();
      }
    } catch(e) { console.warn('saveActiveSession', e); }
  });
  return _sessionSaveChain;
}

/* ═══════════════════════════════════════
   AI PROMPTS
═══════════════════════════════════════ */
const PROMPTS_DIVERTIDO = {
  geral:`Você é o Professor Roberto, professor particular animado e engraçado. Usa emojis, faz piadas, usa gírias jovens mas sem exagero. REGRA DE OURO: Guia, não entrega. Faz perguntas para o aluno pensar.`,
  matematica:`Você é o Professor Roberto, professor de Matemática. Adora analogias criativas com o cotidiano. REGRA DE OURO: Jamais dá a resposta. Pergunta qual fórmula o aluno acha que deve usar.`,
  fisica:`Você é o Professor Roberto, professor de Física. Usa exemplos criativos do cotidiano. REGRA DE OURO: Jamais dá a resposta. Pergunta qual fórmula o aluno acha que deve usar.`,
  quimica:`Você é o Professor Roberto, professor de Química. Faz trocadilhos horríveis com a tabela periódica. REGRA DE OURO: Jamais resolve pelo aluno.`,
  biologia:`Você é o Professor Roberto, professor de Biologia. Ama curiosidades bizarras. REGRA DE OURO: Conta curiosidade e pergunta o que o aluno conclui.`,
  historia:`Você é o Professor Roberto, professor de História. Narra de forma dramática e engraçada. REGRA DE OURO: Contextualiza e pergunta "O que você acha que motivou essa decisão?".`,
  geografia:`Você é o Professor Roberto, professor de Geografia. REGRA DE OURO: Dá pista geográfica e pergunta o que o aluno conclui.`,
  portugues:`Você é o Professor Roberto, professor de Português. Adora trocadilhos. REGRA DE OURO: Explica a REGRA sem o exemplo — pede ao aluno aplicar.`,
  ingles:`You are Professor Roberto, private English tutor. Fun, jokes, mix Portuguese and English. GOLDEN RULE: Never give the answer directly.`,
  filosofia:`Você é o Professor Roberto, professor de Filosofia. REGRA DE OURO: Faz perguntas filosóficas provocativas.`,
  sociologia:`Você é o Professor Roberto, professor de Sociologia. REGRA DE OURO: Jamais entrega a análise pronta.`,
  enem:`Você é o Professor Roberto, coach para o ENEM. Chama o aluno de "futuro universitário". REGRA DE OURO: Jamais resolve questão pelo aluno.`
};
const PROMPTS_FORMAL = {
  geral:`Você é um assistente educacional formal e preciso, especializado no Ensino Médio brasileiro. Responda com linguagem culta, estruturada. Use Markdown com títulos, subtítulos e listas.`,
  matematica:`Você é um assistente de Matemática, formal e rigoroso. Apresente soluções completas com demonstrações.`,
  fisica:`Você é um assistente de Física, formal e rigoroso. Apresente leis, fórmulas e deduções completas.`,
  quimica:`Você é um assistente de Química, formal e preciso. Use terminologia adequada.`,
  biologia:`Você é um assistente de Biologia, formal e cientificamente rigoroso. Use nomenclatura científica.`,
  historia:`Você é um assistente de História, formal e analítico. Apresente diferentes interpretações historiográficas.`,
  geografia:`Você é um assistente de Geografia, formal e analítico. Use rigor técnico.`,
  portugues:`Você é um assistente de Língua Portuguesa, formal e preciso.`,
  ingles:`You are a formal educational assistant for English language learning.`,
  filosofia:`Você é um assistente de Filosofia, formal e academicamente rigoroso.`,
  sociologia:`Você é um assistente de Sociologia, formal e analítico.`,
  enem:`Você é um assistente especializado em preparação para o ENEM, com abordagem formal e técnica.`
};

/* ═══════════════════════════════════════
   SUGGESTIONS / WELCOME
═══════════════════════════════════════ */
const SUGS_POOL = {
  divertido: [
    {icon:'⚛️',title:'Lei de Newton',desc:'De um jeito divertido',q:'Explique a Lei de Newton de um jeito divertido'},
    {icon:'📐',title:'Equação 2º grau',desc:'Passo a passo',q:'Como resolver equação do 2º grau?'},
    {icon:'🏛️',title:'1ª Guerra Mundial',desc:'História com humor',q:'Quais foram as causas da Primeira Guerra Mundial?'},
    {icon:'🎯',title:'Dicas pro ENEM',desc:'Coach animado',q:'Me dá 5 dicas pra me sair bem no ENEM'},
    {icon:'🧪',title:'Tabela Periódica',desc:'Sem decorar tudo',q:'Como entender a tabela periódica sem precisar decorar tudo?'},
    {icon:'🌿',title:'Fotossíntese',desc:'De forma criativa',q:'Me explica fotossíntese de um jeito criativo'},
    {icon:'📝',title:'Tipos de texto',desc:'Qual a diferença?',q:'Qual a diferença entre texto narrativo, descritivo e dissertativo?'},
    {icon:'🤔',title:'O que é filosofia?',desc:'Descomplicada',q:'Me explica o que é filosofia de um jeito descomplicado'},
  ],
  formal: [
    {icon:'📝',title:'Redação ENEM',desc:'Estrutura completa',q:'Como estruturar uma redação dissertativa-argumentativa para o ENEM?'},
    {icon:'📖',title:'Revolução Industrial',desc:'Resumo acadêmico',q:'Faça um resumo acadêmico sobre a Revolução Industrial'},
    {icon:'🔬',title:'Relatório Científico',desc:'Formato correto',q:'Como estruturar um relatório de experimento científico?'},
    {icon:'🏛️',title:'Guerra Fria',desc:'Análise historiográfica',q:'Faça uma análise historiográfica da Guerra Fria'},
  ]
};

function pickRandomSugs(mode) {
  const pool = [...(SUGS_POOL[mode] || SUGS_POOL.divertido)];
  const picked = [];
  while (picked.length < 4 && pool.length > 0) { const idx = Math.floor(Math.random()*pool.length); picked.push(pool.splice(idx,1)[0]); }
  return picked;
}

function renderWelcome() {
  const mode = state.currentMode;
  const isFun = mode !== 'formal';
  const sugs = pickRandomSugs(mode);
  const chat = document.getElementById('chat');
  const badge = isFun ? '😄 Modo Estripulia' : '📋 Modo Acadêmico';
  const title = isFun ? `Fala aí! Sou o <span class="grad">Prof. Roberto</span>` : `Bem-vindo ao <span class="grad">Assistente Acadêmico</span>`;
  const sub = isFun ? 'Sua aula particular com humor. Manda a dúvida! 🚀' : 'Conteúdo estruturado para trabalhos e pesquisas.';
  chat.innerHTML = `<div class="welcome" id="welcome"><div class="prof-avatar-big"><div class="avatar-glow"></div>${isFun?'👨‍🏫':'📚'}</div><div class="welcome-badge">${badge}</div><div class="welcome-title">${title}</div><p class="welcome-sub">${sub}</p><div class="suggestions" id="sugGrid"></div></div>`;
  const grid = document.getElementById('sugGrid');
  sugs.forEach(s => { const div = document.createElement('div'); div.className = 'sug-card'; div.innerHTML = `<div class="sug-icon">${s.icon}</div><div class="sug-title">${s.title}</div><div class="sug-desc">${s.desc}</div>`; div.addEventListener('click', () => sendSuggestion(s.q)); grid.appendChild(div); });
}

/* ═══════════════════════════════════════
   MODE / SUBJECT / PROVIDER
═══════════════════════════════════════ */
function setMode(mode) {
  saveActiveSession(); sessionRef = { id: null };
  state.currentMode = mode; state.messages = [];
  stopSpeaking(null);
  document.querySelectorAll('.mode-btn').forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));
  renderWelcome();
}

function setSubject(el, s) {
  saveActiveSession(); sessionRef = { id: null };
  document.querySelectorAll('.chip').forEach(c=>c.classList.remove('active'));
  el.classList.add('active');
  state.currentSubject = s; state.messages = [];
  stopSpeaking(null);
}

function setProvider(provider) {
  if (!CONFIG.providers[provider]) return;
  saveActiveSession(); sessionRef = { id: null };
  state.currentProvider = provider; state.messages = [];
  stopSpeaking(null);
  document.querySelectorAll('.provider-pill').forEach(b=>b.classList.toggle('active',b.dataset.p===provider));
  renderWelcome();
}

function clearChat() {
  saveActiveSession(); sessionRef = { id: null };
  state.messages = []; state.attachedPDF = null;
  document.getElementById('pdfAttachment').style.display = 'none';
  stopSpeaking(null);
  renderWelcome();
}

/* ═══════════════════════════════════════
   PDF HANDLING
═══════════════════════════════════════ */
function handlePDFAttach(event) {
  const file = event.target.files[0]; if (!file) return;
  readPDFText(file, text => {
    if (!text) { event.target.value = ''; return; }
    state.attachedPDF = { name: file.name, text };
    showPDFAttachmentBar(file.name);
    showToast('📎 PDF anexado: ' + file.name, 'success'); setTimeout(hideToast, 3000);
  });
}

const PDFJS_WORKER_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const TESSERACT_SRC    = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const PDF_MAX_CHARS    = 12000;  // limite de texto enviado à IA
const PDF_OCR_MAX_PAGES = 8;     // OCR é pesado: limita as páginas lidas por imagem

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-lazy="${src}"]`)) { resolve(); return; }
    const sc = document.createElement('script');
    sc.src = src; sc.async = true; sc.dataset.lazy = src;
    sc.onload = () => resolve();
    sc.onerror = () => reject(new Error('Não foi possível carregar o módulo de OCR. Verifique sua conexão.'));
    document.head.appendChild(sc);
  });
}

/** Lê o PDF com PDF.js; se for escaneado (quase sem texto), usa OCR (Tesseract.js, em português). */
async function extractPDFText(file, onStatus = () => {}) {
  if (!window.pdfjsLib) throw new Error('O leitor de PDF não carregou. Recarregue a página e tente de novo.');
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
  const buf = await file.arrayBuffer();
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  } catch (e) {
    if (e?.name === 'PasswordException') throw new Error('Este PDF é protegido por senha.');
    throw new Error('Não foi possível abrir este PDF (arquivo inválido ou corrompido).');
  }

  // 1) Texto digital
  let text = '', pagesRead = 0;
  for (let i = 1; i <= pdf.numPages && text.length < PDF_MAX_CHARS; i++) {
    onStatus(`📄 Lendo página ${i} de ${pdf.numPages}...`);
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let pageText = '';
    content.items.forEach(it => { pageText += it.str + (it.hasEOL ? '\n' : ' '); });
    text += pageText + '\n';
    pagesRead++;
  }
  let clean = text.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const sparse = clean.replace(/\s/g, '').length < 30 * Math.max(1, pagesRead);

  // 2) OCR para PDFs digitalizados
  if (sparse) {
    onStatus('🔍 PDF digitalizado — iniciando OCR (pode levar alguns instantes)...');
    await loadScriptOnce(TESSERACT_SRC);
    const worker = await Tesseract.createWorker('por');
    try {
      let ocr = '';
      const maxPages = Math.min(pdf.numPages, PDF_OCR_MAX_PAGES);
      for (let i = 1; i <= maxPages && ocr.length < PDF_MAX_CHARS; i++) {
        onStatus(`🔍 OCR: página ${i} de ${maxPages}...`);
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width; canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        const { data } = await worker.recognize(canvas);
        ocr += (data.text || '') + '\n';
      }
      clean = ocr.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    } finally {
      await worker.terminate();
    }
  }

  if (!clean) throw new Error('Não foi possível extrair texto deste PDF.');
  return clean.substring(0, PDF_MAX_CHARS);
}

/** Mantém a assinatura antiga: callback(texto) — ou callback(null) se falhar. */
function readPDFText(file, callback) {
  showToast('📄 Lendo PDF...');
  extractPDFText(file, msg => showToast(msg))
    .then(text => { hideToast(); callback(text); })
    .catch(e => {
      console.warn('readPDFText', e);
      showToast('❌ ' + (e.message || 'Falha ao ler o PDF'), 'error'); setTimeout(hideToast, 5000);
      callback(null);
    });
}
function showPDFAttachmentBar(name) { const bar=document.getElementById('pdfAttachment'); bar.style.display='flex'; bar.innerHTML=`<div class="pdf-attachment"><span class="pdf-icon">📎</span><span class="pdf-name">${esc(name)}</span><button class="pdf-remove" onclick="removePDFAttachment()">✕</button></div>`; }
function removePDFAttachment() { state.attachedPDF=null; document.getElementById('pdfAttachment').style.display='none'; document.getElementById('pdfFileInput').value=''; }
function handleDropZone(event) { event.preventDefault(); document.getElementById('dropZone').classList.remove('drag-over'); const file=event.dataTransfer.files[0]; if(file&&file.type==='application/pdf')processUploadFile(file); }
function handleUploadFile(event) { const file=event.target.files[0]; if(file)processUploadFile(file); }
function processUploadFile(file) {
  state.attachedPDF = { name: file.name, text: null };
  readPDFText(file, text => {
    if (!text) { state.attachedPDF = null; return; }
    state.attachedPDF.text = text;
    const area = document.getElementById('uploadResultArea');
    area.innerHTML = `<div class="upload-result-card"><div class="upload-result-title">📄 ${esc(file.name)}</div><div class="upload-result-content" style="color:var(--text-muted);font-size:12px">${esc(text.substring(0,200))}...</div><div class="upload-actions-row"><button class="upload-action-btn summarize" onclick="doUploadAction('summarize')">📝 Resumo</button><button class="upload-action-btn quiz" onclick="doUploadAction('quiz')">🎯 Quiz</button><button class="upload-action-btn chat" onclick="doUploadAction('chat')">💬 Chat</button></div></div><div id="uploadOutputArea"></div>`;
    showToast('✅ PDF carregado!', 'success'); setTimeout(hideToast, 2500);
  });
}
async function doUploadAction(action) {
  if (!state.attachedPDF?.text) return;
  const outArea = document.getElementById('uploadOutputArea'); outArea.innerHTML = '<div class="spinner"></div>';
  const year = document.getElementById('uploadYear')?.value || '1º ano Ensino Médio';
  let prompt = '';
  if (action==='summarize') prompt=`Faça um resumo estruturado e completo deste documento para um aluno do ${year}. Adapte a linguagem e profundidade ao nível ${year}. Use Markdown com títulos, subtítulos e bullet points.\n\nCONTEÚDO:\n${state.attachedPDF.text.substring(0,8000)}`;
  else if (action==='quiz') prompt=`Com base neste documento, crie 5 questões de múltipla escolha (A, B, C, D) adequadas para o ${year}, com respostas e explicações.\n\nCONTEÚDO:\n${state.attachedPDF.text.substring(0,8000)}`;
  else { showPDFAttachmentBar(state.attachedPDF.name); setView('chat'); showToast('📎 PDF no chat!', 'success'); setTimeout(hideToast, 3000); return; }
  try {
    const sys = (state.currentMode==='formal'?PROMPTS_FORMAL:PROMPTS_DIVERTIDO)[state.currentSubject] || PROMPTS_DIVERTIDO.geral;
    const { reply } = await callAI(sys, [{role:'user',parts:[{text:prompt}]}], 0.5);
    outArea.innerHTML = `<div class="upload-result-card"><div class="upload-result-title">${action==='summarize'?'📝 Resumo':'🎯 Quiz'} <span style="font-size:11px;color:var(--text-muted);font-weight:400">• ${year}</span></div><div class="upload-result-content bubble">${renderBubble(reply)}</div></div>`;
    outArea.querySelectorAll('pre code').forEach(b=>hljs.highlightElement(b));
  } catch(e) { outArea.innerHTML = `<div style="color:var(--red);padding:16px;">❌ ${esc(e.message)}</div>`; }
}

/* ═══════════════════════════════════════
   QUIZ GENERATOR
═══════════════════════════════════════ */
let currentQuiz = null;
async function generateQuiz() {
  const subject=document.getElementById('quizSubject').value;
  const diff=document.getElementById('quizDiff').value;
  const qty=document.getElementById('quizQty').value;
  const year=document.getElementById('quizYear')?.value || '1º ano Ensino Médio';
  const btn=document.getElementById('quizGenBtn'), container=document.getElementById('quizContainer'), scoreBar=document.getElementById('quizScoreBar');
  btn.disabled=true; btn.textContent='⏳ Gerando...'; container.innerHTML='<div class="spinner"></div>'; scoreBar.style.display='none';
  const prompt=`Gere exatamente ${qty} questões de múltipla escolha sobre ${subject} com dificuldade ${diff}, adequadas para alunos do ${year} do ensino brasileiro.\nAdapte a linguagem, profundidade e complexidade ao nível ${year}.\nRESPONDA APENAS com JSON válido:\n{"questions":[{"question":"texto","options":["A) texto","B) texto","C) texto","D) texto"],"correct":0,"explanation":"explicação breve"}]}`;
  try {
    const { reply } = await callAI(`Você é um gerador de questões educacionais brasileiro. Adapte sempre ao nível escolar indicado. Responda APENAS com JSON válido, sem texto adicional.`, [{role:'user',parts:[{text:prompt}]}], 0.7);
    let clean=reply.trim().replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
    const s=clean.indexOf('{'),e=clean.lastIndexOf('}'); if(s>=0&&e>s)clean=clean.substring(s,e+1);
    const data=JSON.parse(clean);
    currentQuiz={ questions:data.questions, answers:new Array(data.questions.length).fill(null), submitted:false, year, subject, dbId:null };
    renderQuiz();
    // Cria o registro (pontuação 0 = ainda não respondido); submitQuiz() atualiza este mesmo registro.
    if (currentUser) {
      currentQuiz.dbId = await DB.saveQuizResult(currentUser.id, subject, 0, data.questions.length);
      await DB.logActivity(currentUser.id, 'quiz', `Quiz: ${year} | ${subject} | ${diff}`);
    }
  } catch(e) { container.innerHTML=`<div style="color:var(--red);text-align:center;padding:32px">❌ Erro: ${esc(e.message)}<br><small>Tente novamente</small></div>`; }
  btn.disabled=false; btn.textContent='⚡ Gerar Quiz';
}

function renderQuiz() {
  if (!currentQuiz) return;
  const container=document.getElementById('quizContainer');
  const yearBadge = currentQuiz.year ? `<span style="font-size:10px;color:var(--purple);background:rgba(168,85,247,0.1);border:1px solid rgba(168,85,247,0.2);padding:2px 8px;border-radius:20px;margin-left:8px">${currentQuiz.year}</span>` : '';
  container.innerHTML=currentQuiz.questions.map((q,i)=>`
    <div class="quiz-card">
      <div class="quiz-q-num">Questão ${i+1} de ${currentQuiz.questions.length}${i===0?yearBadge:''}</div>
      <div class="quiz-q-text">${esc(q.question)}</div>
      <div class="quiz-options">${q.options.map((opt,j)=>`<button class="quiz-opt" onclick="selectAnswer(${i},${j})">${esc(opt)}</button>`).join('')}</div>
      <div class="quiz-explanation" id="exp-${i}">${esc(q.explanation)}</div>
    </div>`).join('') + `<button class="quiz-submit-btn" onclick="submitQuiz()">✅ Ver resultado</button>`;
}

function selectAnswer(qIdx,optIdx) {
  if (currentQuiz.submitted) return;
  currentQuiz.answers[qIdx]=optIdx;
  const card=document.getElementById('quizContainer').querySelectorAll('.quiz-card')[qIdx];
  card.querySelectorAll('.quiz-opt').forEach((b,i)=>b.classList.toggle('selected',i===optIdx));
}

async function submitQuiz() {
  if (!currentQuiz || currentQuiz.submitted) return;
  currentQuiz.submitted=true;
  let correct=0;
  currentQuiz.questions.forEach((q,i)=>{
    const card=document.getElementById('quizContainer').querySelectorAll('.quiz-card')[i];
    const opts=card.querySelectorAll('.quiz-opt');
    const ans=currentQuiz.answers[i];
    opts.forEach((b,j)=>{ if(j===q.correct)b.classList.add('correct'); else if(j===ans&&ans!==q.correct)b.classList.add('wrong'); });
    if(ans===q.correct)correct++;
    const exp=document.getElementById('exp-'+i); if(exp)exp.classList.add('show');
  });
  const pct=correct/currentQuiz.questions.length;
  state.gamification.quizScores.push(pct);
  state.gamification.quizzesCompleted++;   // só conta quando o quiz é de fato respondido
  touchStreak();
  const scoreBar=document.getElementById('quizScoreBar');
  scoreBar.style.display='flex'; scoreBar.innerHTML=`<div class="quiz-score-bar"><span style="font-size:32px;font-family:'JetBrains Mono',monospace;font-weight:600;color:${pct>=0.7?'#00ff9d':pct>=0.5?'#fbbf24':'#f87171'}">${correct}/${currentQuiz.questions.length}</span><div><div style="font-family:'Syne',sans-serif;font-size:16px;font-weight:800;color:var(--text)">${Math.round(pct*100)}% de acerto</div><div style="font-size:12px;color:var(--text-muted)">${pct>=0.8?'🏆 Excelente!':pct>=0.6?'👍 Bom trabalho!':'📚 Continue estudando!'}</div></div></div>`;
  updateGamificationUI();
  if (currentUser) {
    // Atualiza o registro original com os acertos reais (ou cria, se a criação inicial falhou)
    if (currentQuiz.dbId) {
      const ok = await DB.updateQuizResult(currentQuiz.dbId, correct, currentQuiz.questions.length);
      if (!ok) currentQuiz.dbId = await DB.saveQuizResult(currentUser.id, currentQuiz.subject, correct, currentQuiz.questions.length);
    } else {
      currentQuiz.dbId = await DB.saveQuizResult(currentUser.id, currentQuiz.subject, correct, currentQuiz.questions.length);
    }
    DB.saveGamification(currentUser.id, state.gamification);
  }
}

/* ═══════════════════════════════════════
   PLAN GENERATOR
═══════════════════════════════════════ */
async function generatePlan() {
  const goal=document.getElementById('planGoal').value;
  const weeks=document.getElementById('planWeeks').value;
  const hours=document.getElementById('planHours').value;
  const year=document.getElementById('planYear')?.value || '1º ano Ensino Médio';
  const btn=document.getElementById('planGenBtn'), container=document.getElementById('planContainer');
  btn.disabled=true; btn.textContent='⏳ Gerando...'; container.innerHTML='<div class="spinner"></div>';
  const prompt=`Crie um plano de estudos de ${weeks} semanas para um aluno do ${year}, objetivo: ${goal}, ${hours}h/dia.\nAdapte os conteúdos, matérias e ritmo ao nível ${year}.\nRESPONDA APENAS com JSON:\n{"weeks":[{"week":1,"theme":"tema da semana","days":[{"day":"Seg","tasks":["tarefa específica 1","tarefa específica 2"]}]}]}`;
  try {
    const { reply } = await callAI(`Você é um especialista em planejamento de estudos para o sistema educacional brasileiro. Adapte sempre ao ano escolar indicado. Responda APENAS com JSON válido.`, [{role:'user',parts:[{text:prompt}]}], 0.7);
    let clean=reply.trim().replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
    const s=clean.indexOf('{'),e=clean.lastIndexOf('}'); if(s>=0&&e>s)clean=clean.substring(s,e+1);
    const data=JSON.parse(clean);
    renderPlan(data.weeks);
  } catch(e) { container.innerHTML=`<div style="color:var(--red);text-align:center;padding:32px">❌ Erro: ${esc(e.message)}</div>`; }
  btn.disabled=false; btn.textContent='📅 Gerar Plano';
}

function renderPlan(weeks) {
  if (!weeks?.length) return;
  document.getElementById('planContainer').innerHTML=weeks.map((w,wi)=>`
    <div class="plan-week"><div class="plan-week-title">📅 Semana ${w.week}${w.theme?` — ${esc(w.theme)}`:''}</div>
    <div class="plan-days-grid">${(w.days||[]).map((d,di)=>`<div class="plan-day"><div class="plan-day-name">${esc(d.day)}</div><div class="plan-day-tasks">${(d.tasks||[]).map((task,ti)=>{const key=`w${wi}d${di}t${ti}`;return`<div class="plan-task" id="pt-${key}" onclick="togglePlanTask('${key}')"><div class="plan-task-check" id="ptc-${key}"></div>${esc(task)}</div>`}).join('')}</div></div>`).join('')}</div></div>`).join('');
}

function togglePlanTask(key) {
  const task=document.getElementById('pt-'+key); const check=document.getElementById('ptc-'+key); if(!task)return;
  task.classList.toggle('done'); check.textContent=task.classList.contains('done')?'✓':'';
}

/* ═══════════════════════════════════════
   TTS
═══════════════════════════════════════ */
function stripMarkdown(t) { return t.replace(/```[\s\S]*?```/g,'código.').replace(/`[^`]+`/g,'').replace(/#{1,6}\s*/g,'').replace(/\*\*(.+?)\*\*/g,'$1').replace(/\*(.+?)\*/g,'$1').replace(/^[-*]\s/gm,'').replace(/^>\s/gm,'').replace(/\n+/g,' ').trim(); }
async function speakText(text, btn) {
  if (state.isSpeaking) { stopSpeaking(btn); return; }
  const clean=stripMarkdown(text); if(!clean)return;
  setBtnSpeaking(btn,true); showTTSBar(true);
  try {
    const res = await invokeEdgeFunction('text-to-speech', { text: clean }, { binary: true });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    state.currentAudio=new Audio(url); state.isSpeaking=true;
    state.currentAudio.onended=()=>{ state.isSpeaking=false; state.currentAudio=null; setBtnSpeaking(btn,false); showTTSBar(false); URL.revokeObjectURL(url); };
    state.currentAudio.onerror=()=>fallbackTTS(clean,btn);
    state.currentAudio.play();
  } catch(e) { fallbackTTS(clean,btn); }
}
function fallbackTTS(clean,btn) {
  const utter=new SpeechSynthesisUtterance(clean); utter.lang='pt-BR'; utter.rate=1; utter.pitch=0.8; utter.volume=1;
  const voices=speechSynthesis.getVoices(); const male=voices.find(v=>v.lang==='pt-BR'&&!/female|feminin|luc[íi]a|vitoria/i.test(v.name))||voices.find(v=>v.lang==='pt-BR');
  if(male)utter.voice=male;
  utter.onstart=()=>{ state.isSpeaking=true; setBtnSpeaking(btn,true); showTTSBar(true); };
  utter.onend=utter.onerror=()=>{ state.isSpeaking=false; setBtnSpeaking(btn,false); showTTSBar(false); };
  speechSynthesis.cancel(); setTimeout(()=>speechSynthesis.speak(utter),50);
}
function stopSpeaking(btn) { if(state.currentAudio){state.currentAudio.pause();state.currentAudio=null;} speechSynthesis.cancel(); state.isSpeaking=false; setBtnSpeaking(btn,false); showTTSBar(false); }
function setBtnSpeaking(btn,on) { if(!btn)return; btn.classList.toggle('speaking',on); btn.innerHTML=on?`<span class="bar"><span></span><span></span><span></span><span></span></span> Parar`:`🔊 Ouvir`; }
function showTTSBar(on) { document.getElementById('ttsBar').className=on?'tts-bar active':'tts-bar'; }

/* ═══════════════════════════════════════
   SPEECH RECOGNITION
═══════════════════════════════════════ */
function buildRec() {
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition; if(!SR)return null;
  const r=new SR(); r.lang='pt-BR'; r.continuous=false; r.interimResults=true;
  r.onstart=()=>{ state.isListening=true; document.getElementById('micBtn').classList.add('listening'); showToast('🎤 Ouvindo...','mic'); };
  r.onresult=e=>{ let f='',interim=''; for(let x=e.resultIndex;x<e.results.length;x++){if(e.results[x].isFinal)f+=e.results[x][0].transcript;else interim+=e.results[x][0].transcript;} const ta=document.getElementById('userInput'); ta.value=f||interim; ta.style.height='auto'; ta.style.height=Math.min(ta.scrollHeight,120)+'px'; };
  r.onend=()=>{ state.isListening=false; document.getElementById('micBtn').classList.remove('listening'); hideToast(); const ta=document.getElementById('userInput'); if(ta.value.trim())sendMessage(); };
  r.onerror=e=>{ state.isListening=false; document.getElementById('micBtn').classList.remove('listening'); showToast('❌ '+(e.error==='not-allowed'?'Permita o microfone':'Erro: '+e.error),'error'); setTimeout(hideToast,3000); };
  return r;
}
function toggleMic() {
  if(!state.recognition)state.recognition=buildRec();
  if(!state.recognition){showToast('❌ Microfone não suportado','error');setTimeout(hideToast,3000);return;}
  if(state.isListening)state.recognition.stop();
  else{try{state.recognition.start();}catch(e){state.recognition=buildRec();state.recognition?.start();}}
}

/* ═══════════════════════════════════════
   TOAST
═══════════════════════════════════════ */
function showToast(msg,type=''){const t=document.getElementById('toast');t.textContent=msg;t.className='toast show'+(type?' '+type:'');}
function hideToast(){document.getElementById('toast').className='toast';}

/* ═══════════════════════════════════════
   AI CALLER — Edge Function (sem chaves no browser)
═══════════════════════════════════════ */
async function callAI(systemPrompt, messages, temperature = 0.7) {
  if (!CONFIG.providers[state.currentProvider]) throw new Error('Provider desconhecido');
  const data = await invokeEdgeFunction('ai-generate', {
    provider: state.currentProvider,
    systemPrompt,
    messages,
    temperature
  });
  if (data.error) throw new Error(data.error);
  return { reply: data.reply, usedModel: data.usedModel };
}

/* ═══════════════════════════════════════
   SEND MESSAGE
═══════════════════════════════════════ */
function sendSuggestion(t){document.getElementById('userInput').value=t;sendMessage();}

async function sendMessage() {
  if (state.isLoading) return;
  const ta=document.getElementById('userInput'); let text=ta.value.trim(); if(!text)return;
  let textWithCtx=text;
  if(state.attachedPDF?.text) textWithCtx=`[Contexto do PDF: "${state.attachedPDF.name}"]\n${state.attachedPDF.text.substring(0,4000)}\n\n[Pergunta do aluno]: ${text}`;
  ta.value=''; ta.style.height='auto';
  const welcome=document.getElementById('welcome'); if(welcome)welcome.remove();
  appendMsg('user',text);
  state.messages.push({role:'user',parts:[{text:textWithCtx}]});
  const typingEl=appendTyping();
  state.isLoading=true;
  document.getElementById('sendBtn').disabled=true;
  document.getElementById('micBtn').disabled=true;
  try {
    const promptSet=state.currentMode==='formal'?PROMPTS_FORMAL:PROMPTS_DIVERTIDO;
    let sys=promptSet[state.currentSubject]||promptSet.geral;
    // Modo aula: sobrescreve prompt com contexto da matéria
    if (modoAulaAtivo) {
      const mat = modoAulaAtivo.materia.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
      const subjectKey = Object.keys(promptSet).find(k => mat.includes(k)) || 'geral';
      sys = (promptSet[subjectKey] || promptSet.geral) + `\n\n[MODO AULA ATIVO] Você está dando aula de ${modoAulaAtivo.materia} para a turma ${modoAulaAtivo.serie} ${modoAulaAtivo.turma}. Priorize explicações dessa disciplina.`;
    }
    const {reply,usedModel}=await callAI(sys,state.messages,0.8);
    typingEl.remove();
    state.messages.push({role:'model',parts:[{text:reply}]});
    appendMsg('ai',reply,usedModel);
    trackMsg(state.currentSubject);
    if(currentUser) await DB.logActivity(currentUser.id,'message',`Msg em ${state.currentSubject}`);
    // Salva/atualiza a sessão a cada resposta (sem bloquear a UI)
    saveActiveSession();
  } catch(e) {
    typingEl.remove();
    const m=e.message.match(/retry in ([\d.]+)s/i);
    if(m){let secs=Math.ceil(parseFloat(m[1]));const errEl=appendMsg('ai',`⏳ Cotas esgotadas. Tentando em **${secs}s**...`);const bubble=errEl.querySelector('.bubble');const timer=setInterval(async()=>{secs--;if(secs<=0){clearInterval(timer);errEl.remove();state.isLoading=false;document.getElementById('sendBtn').disabled=false;document.getElementById('micBtn').disabled=false;const last=state.messages.pop();document.getElementById('userInput').value=last.parts[0].text;sendMessage();}else{bubble.innerHTML=renderBubble(`⏳ Cotas esgotadas. Tentando em **${secs}s**...`);}},1000);return;}
    appendMsg('ai',`❌ Erro: ${e.message}`);
  }
  state.isLoading=false;
  document.getElementById('sendBtn').disabled=false;
  document.getElementById('micBtn').disabled=false;
}

/* ═══════════════════════════════════════
   MARKDOWN & DOM
═══════════════════════════════════════ */
function parseMd(text) {
  return text
    .replace(/```(\w*)\n?([\s\S]*?)```/g,(_,l,c)=>`<pre><code class="${l||''}">${c.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</code></pre>`)
    .replace(/^### (.+)$/gm,'<h3>$1</h3>').replace(/^## (.+)$/gm,'<h2>$1</h2>').replace(/^# (.+)$/gm,'<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*(.+?)\*/g,'<em>$1</em>').replace(/`([^`\n]+)`/g,'<code>$1</code>')
    .replace(/^> (.+)$/gm,'<blockquote>$1</blockquote>').replace(/^---$/gm,'<hr>')
    .replace(/^\* (.+)$/gm,'<li>$1</li>').replace(/^- (.+)$/gm,'<li>$1</li>').replace(/(<li>.*<\/li>\n?)+/g,'<ul>$&</ul>')
    .replace(/^\d+\. (.+)$/gm,'<li>$1</li>').replace(/\n\n+/g,'</p><p>');
}
function renderBubble(t){let h=parseMd(t);if(!h.match(/^<(h[1-6]|ul|ol|pre|blockquote|hr)/))h='<p>'+h+'</p>';return h;}
function appendMsg(role,text,model) {
  const chat=document.getElementById('chat'); const div=document.createElement('div'); div.className=`message ${role}`;
  const avatar=state.currentMode==='formal'?'📚':'👨‍🏫';
  if(role==='ai'){div.dataset.raw=text;div.innerHTML=`<div class="avatar ai">${avatar}</div><div style="min-width:0;flex:1"><div class="bubble">${renderBubble(text)}</div><div class="msg-actions"><button class="speak-btn" onclick="speakText(this.closest('.message').dataset.raw,this)">🔊 Ouvir</button><button class="copy-btn" onclick="copyMsg(this.closest('.message').dataset.raw)">📋 Copiar</button>${model?`<span class="model-badge">${model}</span>`:''}</div></div>`;}
  else{div.innerHTML=`<div class="avatar user">🙋</div><div class="bubble"><p>${esc(text)}</p></div>`;}
  chat.appendChild(div); div.querySelectorAll('pre code').forEach(b=>hljs.highlightElement(b));
  const wrapper=document.getElementById('chatWrapper'); wrapper.scrollTop=wrapper.scrollHeight;
  return div;
}
function appendTyping(){const chat=document.getElementById('chat');const div=document.createElement('div');div.className='message ai';const avatar=state.currentMode==='formal'?'📚':'👨‍🏫';div.innerHTML=`<div class="avatar ai">${avatar}</div><div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>`;chat.appendChild(div);const wrapper=document.getElementById('chatWrapper');wrapper.scrollTop=wrapper.scrollHeight;return div;}
function esc(t){return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function copyMsg(text){navigator.clipboard.writeText(text).then(()=>{showToast('📋 Copiado!','success');setTimeout(hideToast,2000);}).catch(()=>{});}

/* Input textarea auto-resize */
document.getElementById('userInput').addEventListener('input', function() { this.style.height='auto'; this.style.height=Math.min(this.scrollHeight,120)+'px'; });
document.getElementById('userInput').addEventListener('keydown', e => { if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}});

/* ═══════════════════════════════════════
   ADMIN PANEL
═══════════════════════════════════════ */
let adminAllUsers = [];
let adminAllLogs  = [];

async function openAdminPanel() {
  const isAdmin = currentUser?.is_admin === true || currentUser?.email === SUPREME_ADMIN_EMAIL;
  if (!isAdmin) { showToast('⛔ Acesso negado', 'error'); setTimeout(hideToast, 2500); return; }
  document.getElementById('admin-screen').classList.remove('hidden');
  toggleUserDropdown(false);
  await loadAdminData();
}

function closeAdminPanel() { document.getElementById('admin-screen').classList.add('hidden'); }

function switchAdminView(view) {
  closeAdminNav('admin-screen');
  document.querySelectorAll('.admin-view').forEach(v=>v.classList.remove('active'));
  document.querySelectorAll('.admin-nav-item').forEach(i=>i.classList.remove('active'));
  document.getElementById('admin-view-'+view).classList.add('active');
  document.querySelector(`.admin-nav-item[data-view="${view}"]`).classList.add('active');
  if (view === 'pesquisas') loadPesquisas();
  if (view === 'broadcast') renderBroadcastList();
}

/* ── DADOS BRUTOS DAS PESQUISAS ── */
let pesquisasRawData = [];

async function loadPesquisas() {
  const dias = parseInt(document.getElementById('pesqPeriodo')?.value || '30');
  const usuarioFiltro = document.getElementById('pesqUsuario')?.value || 'all';

  // Busca chat_history com dados do usuário
  try {
    let query = sb.from('chat_history')
      .select('id, user_id, subject, message, preview, created_at, users(name, email)')
      .order('created_at', { ascending: false })
      .limit(500);

    if (dias < 999) {
      const desde = new Date(Date.now() - dias * 86400000).toISOString();
      query = query.gte('created_at', desde);
    }
    if (usuarioFiltro !== 'all') {
      query = query.eq('user_id', usuarioFiltro);
    }

    const { data, error } = await query;
    if (error) { console.warn('loadPesquisas error:', error); return; }

    pesquisasRawData = data || [];

    // Popula select de usuários
    const sel = document.getElementById('pesqUsuario');
    if (sel) {
      const currentVal = sel.value;
      const uniqUsers = {};
      pesquisasRawData.forEach(r => {
        if (r.user_id && r.users) uniqUsers[r.user_id] = r.users.name || r.users.email || r.user_id;
      });
      sel.innerHTML = '<option value="all">Todos os alunos</option>' +
        Object.entries(uniqUsers).map(([id, name]) =>
          `<option value="${id}"${id === currentVal ? ' selected' : ''}>${esc(name)}</option>`
        ).join('');
    }

    renderPesquisas(pesquisasRawData);
  } catch(e) {
    console.warn('loadPesquisas exception:', e);
    document.getElementById('pesqHistoryBody').innerHTML =
      `<tr><td colspan="4" style="text-align:center;padding:32px;color:var(--red)">❌ Erro ao carregar. Verifique as policies RLS.</td></tr>`;
  }
}

function renderPesquisas(data) {
  const subjectEmojis = {geral:'✨',matematica:'📐',fisica:'⚛️',quimica:'🧪',biologia:'🌿',historia:'🏛️',geografia:'🌍',portugues:'📝',ingles:'🇬🇧',filosofia:'🤔',sociologia:'👥',enem:'🎯'};
  const subColors = {'geral':'#00d4ff','matematica':'#00ff9d','fisica':'#a855f7','quimica':'#fbbf24','biologia':'#34d399','historia':'#f87171','geografia':'#60a5fa','portugues':'#f472b6','ingles':'#fb923c','filosofia':'#c084fc','sociologia':'#94a3b8','enem':'#fde68a'};

  // Conta matérias
  const subCounts = {};
  data.forEach(r => {
    const sub = r.subject || 'geral';
    subCounts[sub] = (subCounts[sub] || 0) + 1;
  });
  const sorted = Object.entries(subCounts).sort((a,b)=>b[1]-a[1]);
  const totalMsgs = data.length;

  // Cards de matérias
  const cardsEl = document.getElementById('pesqSubjectCards');
  if (cardsEl) {
    cardsEl.innerHTML = sorted.length ? sorted.map(([sub, cnt]) => {
      const pct = totalMsgs ? Math.round((cnt/totalMsgs)*100) : 0;
      const color = subColors[sub] || '#00d4ff';
      return `<div class="admin-stat-card" style="border-color:${color}22;position:relative;overflow:hidden">
        <div style="position:absolute;inset:0;background:${color}08;pointer-events:none"></div>
        <div style="font-size:22px;margin-bottom:6px">${subjectEmojis[sub]||'📖'}</div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:28px;font-weight:600;color:${color}">${cnt}</div>
        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;margin-top:2px">${sub}</div>
        <div style="font-size:10px;color:${color};margin-top:4px">${pct}% do total</div>
      </div>`;
    }).join('') : '<div style="color:var(--text-muted);font-size:12px">Nenhuma pesquisa encontrada no período.</div>';
  }

  // Gráfico de barras
  const chartEl = document.getElementById('pesqSubjectChart');
  if (chartEl) {
    const max = sorted[0]?.[1] || 1;
    chartEl.innerHTML = sorted.map(([sub, cnt]) => {
      const pct = Math.round((cnt/max)*100);
      const color = subColors[sub] || '#00d4ff';
      return `<div class="topic-bar-item">
        <div class="topic-bar-header">
          <span class="topic-bar-name">${subjectEmojis[sub]||'📖'} ${sub}</span>
          <span class="topic-bar-val" style="color:${color}">${cnt} pesquisas</span>
        </div>
        <div class="topic-bar-track">
          <div class="topic-bar-fill" style="width:${pct}%;background:${color}"></div>
        </div>
      </div>`;
    }).join('') || '<div style="color:var(--text-muted);font-size:12px">Sem dados</div>';
  }

  // Tabela de histórico
  renderPesquisasTable(data);
}

function renderPesquisasTable(data) {
  const subjectEmojis = {geral:'✨',matematica:'📐',fisica:'⚛️',quimica:'🧪',biologia:'🌿',historia:'🏛️',geografia:'🌍',portugues:'📝',ingles:'🇬🇧',filosofia:'🤔',sociologia:'👥',enem:'🎯'};
  const tbody = document.getElementById('pesqHistoryBody');
  if (!tbody) return;
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:32px;color:var(--text-muted)">Nenhuma pesquisa encontrada</td></tr>';
    return;
  }
  tbody.innerHTML = data.slice(0, 200).map(r => {
    const nome = r.users?.name || r.users?.email || 'Anônimo';
    const sub = r.subject || 'geral';
    const msg = r.preview || r.message || '—';
    const data_fmt = new Date(r.created_at).toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
    return `<tr>
      <td><div class="admin-user-name">${esc(nome)}</div></td>
      <td><span style="font-size:11px;padding:3px 8px;border-radius:20px;background:rgba(0,212,255,0.08);border:1px solid rgba(0,212,255,0.15);color:var(--cyan)">${subjectEmojis[sub]||'📖'} ${sub}</span></td>
      <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-dim)">${esc(msg.substring(0,120))}</td>
      <td style="font-size:11px;color:var(--text-muted);white-space:nowrap">${data_fmt}</td>
    </tr>`;
  }).join('');
}

function filterPesquisas() {
  const q = document.getElementById('pesqSearch')?.value.toLowerCase() || '';
  if (!q) { renderPesquisasTable(pesquisasRawData); return; }
  const filtered = pesquisasRawData.filter(r =>
    (r.preview||'').toLowerCase().includes(q) ||
    (r.message||'').toLowerCase().includes(q) ||
    (r.subject||'').toLowerCase().includes(q) ||
    (r.users?.name||'').toLowerCase().includes(q) ||
    (r.users?.email||'').toLowerCase().includes(q)
  );
  renderPesquisasTable(filtered);
}

async function loadAdminData() {
  adminAllUsers = await DB.getAllUsers();
  adminAllLogs  = await DB.getAnalytics(200);

  // Detecta bloqueio de RLS: se só veio 1 usuário (provavelmente só o próprio admin),
  // mostra aviso com SQL para corrigir no Supabase
  if (adminAllUsers.length <= 1) {
    const rlsWarn = document.getElementById('adminRlsWarning');
    if (rlsWarn) rlsWarn.style.display = 'block';
  } else {
    const rlsWarn = document.getElementById('adminRlsWarning');
    if (rlsWarn) rlsWarn.style.display = 'none';
  }

  renderAdminOverview();
  renderAdminUsersTable();
  renderAdminRanking();
  renderAdminAnalytics();
  renderAdminLogs();
  renderBroadcastList();
}

function renderAdminOverview() {
  const total = adminAllUsers.length;
  const active = adminAllUsers.filter(u=>!u.banned).length;
  const banned = adminAllUsers.filter(u=>u.banned).length;
  const admins = adminAllUsers.filter(u=>u.is_admin).length;
  const totalMsgs = adminAllUsers.reduce((s,u)=>(u.gamification?.totalMsgs||0)+s,0);
  const totalQuizzes = adminAllUsers.reduce((s,u)=>(u.gamification?.quizzesCompleted||0)+s,0);

  document.getElementById('stat-total-users').textContent = total;
  document.getElementById('stat-active-users').textContent = active;
  document.getElementById('stat-banned-users').textContent = banned;
  document.getElementById('stat-admin-users').textContent = admins;
  document.getElementById('stat-total-msgs').textContent = totalMsgs;
  document.getElementById('stat-total-quizzes').textContent = totalQuizzes;

  // Subject chart
  const subMap = {};
  adminAllUsers.forEach(u => { Object.entries(u.gamification?.subjectCounts||{}).forEach(([s,c])=>{ subMap[s]=(subMap[s]||0)+c; }); });
  const subEntries = Object.entries(subMap).sort((a,b)=>b[1]-a[1]).slice(0,6);
  const maxSub = subEntries[0]?.[1] || 1;
  const subjectChart = document.getElementById('adminSubjectChart');
  subjectChart.innerHTML = subEntries.length ? subEntries.map(([s,c])=>`<div class="topic-bar-item"><div class="topic-bar-header"><span class="topic-bar-name">${s}</span><span class="topic-bar-val">${c}</span></div><div class="topic-bar-track"><div class="topic-bar-fill" style="width:${Math.round((c/maxSub)*100)}%;background:linear-gradient(90deg,#00d4ff,#a855f7)"></div></div></div>`).join('') : '<div style="color:var(--text-muted);font-size:12px">Sem dados</div>';

  // Top students
  const sorted = adminAllUsers.filter(u=>!u.is_admin).sort((a,b)=>(b.gamification?.totalMsgs||0)-(a.gamification?.totalMsgs||0)).slice(0,5);
  document.getElementById('adminTopStudents').innerHTML = sorted.length ? sorted.map((u,i)=>`<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-muted);width:16px">${i+1}</span><div style="flex:1"><div style="font-size:13px;font-weight:700;color:var(--text)">${esc(u.name||u.email)}</div></div><span style="font-size:12px;color:var(--cyan);font-family:'JetBrains Mono',monospace">${u.gamification?.totalMsgs||0} msgs</span></div>`).join('') : '<div style="color:var(--text-muted);font-size:12px">Sem dados</div>';
}

function getLevelPill(msgs) {
  const lvl = getLevel(msgs);
  const cls = lvl<=2?'low':lvl<=5?'mid':lvl<=8?'high':'top';
  return `<span class="level-pill ${cls}">Nv ${lvl}</span>`;
}

function renderAdminUsersTable() {
  const search = (document.getElementById('adminUserSearch')?.value||'').toLowerCase();
  const filter = document.getElementById('adminUserFilter')?.value || 'all';
  let users = adminAllUsers.filter(u => {
    if (search && !((u.name||'').toLowerCase().includes(search) || (u.email||'').toLowerCase().includes(search))) return false;
    if (filter==='active') return !u.banned;
    if (filter==='banned') return u.banned;
    if (filter==='admin') return u.is_admin;
    return true;
  });
  const tbody = document.getElementById('adminUsersBody');
  if (!users.length) { tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--text-muted)">Nenhum usuário encontrado</td></tr>'; return; }
  tbody.innerHTML = users.map(u => {
    const uid = u.id || u.uid;
    const g = u.gamification || {};
    const created = u.created_at ? new Date(u.created_at).toLocaleDateString('pt-BR') : '—';
    const statusBadge = u.banned ? `<span style="font-size:10px;color:#f87171;background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.2);padding:2px 8px;border-radius:20px">⛔ Banido</span>` : u.is_admin ? `<span style="font-size:10px;color:#a855f7;background:rgba(168,85,247,0.1);border:1px solid rgba(168,85,247,0.2);padding:2px 8px;border-radius:20px">🛡️ Admin</span>` : `<span style="font-size:10px;color:#00ff9d;background:rgba(0,255,157,0.1);border:1px solid rgba(0,255,157,0.2);padding:2px 8px;border-radius:20px">✅ Ativo</span>`;
    const tipoLabel = formatTipoConta(u);
    return `<tr><td><div class="admin-user-name">${esc(u.name||'—')}</div><div class="admin-user-email">${esc(u.email||'—')}</div><div class="admin-user-tipo">${tipoLabel}</div></td><td>${getLevelPill(g.totalMsgs||0)}</td><td class="admin-td-hide-sm" style="font-family:'JetBrains Mono',monospace;font-size:12px">${g.totalMsgs||0}</td><td class="admin-td-hide-sm" style="font-family:'JetBrains Mono',monospace;font-size:12px">${g.quizzesCompleted||0}</td><td>${statusBadge}</td><td class="admin-td-hide-sm" style="font-size:11px;color:var(--text-muted)">${created}</td><td class="admin-actions-cell"><button class="admin-action-btn view" onclick="openAdminUserModal('${uid}')">Ver</button><button class="admin-action-btn view" onclick="openRoleModal('${uid}')">Tipo</button>${!u.banned?`<button class="admin-action-btn ban" onclick="adminBanUser('${uid}','${esc(u.name||u.email)}')">Banir</button>`:`<button class="admin-action-btn" onclick="adminUnbanUser('${uid}','${esc(u.name||u.email)}')">Desbanir</button>`}${!u.is_admin?`<button class="admin-action-btn del" onclick="adminDeleteUser('${uid}','${esc(u.name||u.email)}')">Del</button>`:''}</td></tr>`;
  }).join('');
}

function filterAdminUsers() { renderAdminUsersTable(); }

function renderAdminRanking() {
  const sorted = [...adminAllUsers].filter(u=>!u.is_admin).sort((a,b)=>(b.gamification?.totalMsgs||0)-(a.gamification?.totalMsgs||0));
  const medals = ['🥇','🥈','🥉'];
  document.getElementById('adminRankingBody').innerHTML = sorted.map((u,i)=>{
    const g = u.gamification||{};
    return `<tr><td style="font-size:16px">${medals[i]||`#${i+1}`}</td><td><div class="admin-user-name">${esc(u.name||'—')}</div><div class="admin-user-email">${esc(u.email||'—')}</div></td><td>${getLevelPill(g.totalMsgs||0)}</td><td style="font-family:'JetBrains Mono',monospace;font-size:14px;font-weight:600;color:var(--cyan)">${g.totalMsgs||0}</td><td style="font-family:'JetBrains Mono',monospace;font-size:13px">${g.quizzesCompleted||0}</td><td style="font-family:'JetBrains Mono',monospace;font-size:13px">${g.streak||0}</td></tr>`;
  }).join('') || '<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text-muted)">Sem dados</td></tr>';
}

function renderAdminAnalytics() {
  const today = new Date().toDateString();
  const todayLogins = adminAllLogs.filter(l=>l.type==='login'&&new Date(l.created_at).toDateString()===today).length;
  const activeUsers = adminAllUsers.filter(u=>!u.banned);
  const avgMsgs = activeUsers.length ? Math.round(activeUsers.reduce((s,u)=>(u.gamification?.totalMsgs||0)+s,0)/activeUsers.length) : 0;
  const avgQuiz = activeUsers.length ? Math.round(activeUsers.reduce((s,u)=>(u.gamification?.quizzesCompleted||0)+s,0)/activeUsers.length) : 0;
  const maxStreak = Math.max(...adminAllUsers.map(u=>u.gamification?.streak||0), 0);
  document.getElementById('stat-today-logins').textContent = todayLogins;
  document.getElementById('stat-avg-msgs').textContent = avgMsgs;
  document.getElementById('stat-avg-quiz').textContent = avgQuiz;
  document.getElementById('stat-max-streak').textContent = maxStreak;

  // Weekly activity chart
  const days = ['Seg','Ter','Qua','Qui','Sex','Sáb','Dom'];
  const weekTotals = [0,0,0,0,0,0,0];
  const _wk = weekStartKey();
  adminAllUsers.forEach(u => { if (u.gamification?.weekStart !== _wk) return; (u.gamification?.weeklyActivity||[]).forEach((v,i)=>{ weekTotals[i]=(weekTotals[i]||0)+v; }); });
  const maxW = Math.max(...weekTotals, 1);
  document.getElementById('adminWeeklyChart').innerHTML = weekTotals.map((v,i)=>`<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px"><div style="width:100%;height:${Math.max(2,Math.round((v/maxW)*70))}px;background:${i===6?'#00d4ff':'rgba(0,212,255,0.25)'};border-radius:4px 4px 0 0"></div><span style="font-size:9px;color:var(--text-muted)">${days[i]}</span><span style="font-size:9px;color:var(--text-muted);font-family:'JetBrains Mono',monospace">${v}</span></div>`).join('');
}

function renderAdminLogs() {
  const typeFilter = document.getElementById('logTypeFilter')?.value || 'all';
  const search = (document.getElementById('logSearch')?.value||'').toLowerCase();
  const typeIcons = {login:'🔑',logout:'🚪',message:'💬',quiz:'🎯',admin:'🛡️',register:'✨',broadcast:'📢'};
  let logs = adminAllLogs.filter(l => {
    if (typeFilter!=='all' && l.type!==typeFilter) return false;
    if (search && !(l.detail||'').toLowerCase().includes(search) && !(l.users?.email||'').toLowerCase().includes(search)) return false;
    return true;
  }).slice(0, 100);
  const el = document.getElementById('adminLogsBody');
  el.innerHTML = logs.length ? logs.map(l=>`<div class="admin-log-entry"><span class="admin-log-time">${new Date(l.created_at).toLocaleString('pt-BR')}</span><span class="admin-log-icon">${typeIcons[l.type]||'📋'}</span><span class="admin-log-text"><strong>${esc(l.users?.email||l.user_id?.substring(0,8)||'?')}</strong> — ${esc(l.detail||l.type)}</span><span class="admin-log-type ${l.type}">${l.type}</span></div>`).join('') : '<div style="color:var(--text-muted);text-align:center;padding:32px">Nenhum log encontrado</div>';
}

function filterLogs() { renderAdminLogs(); }

function openAdminUserModal(uid) {
  const u = adminAllUsers.find(x=>x.id===uid||x.uid===uid);
  if (!u) return;
  const g = u.gamification || {};
  const overlay = document.getElementById('adminUserModal');
  document.getElementById('modalUserTitle').textContent = u.name || u.email;
  document.getElementById('modalUserBody').innerHTML = `
    <div class="admin-modal-row"><span class="admin-modal-key">Nome</span><span class="admin-modal-val">${esc(u.name||'—')}</span></div>
    <div class="admin-modal-row"><span class="admin-modal-key">E-mail</span><span class="admin-modal-val">${esc(u.email||'—')}</span></div>
    <div class="admin-modal-row"><span class="admin-modal-key">ID</span><span class="admin-modal-val" style="font-family:'JetBrains Mono',monospace;font-size:11px">${uid}</span></div>
    <div class="admin-modal-row"><span class="admin-modal-key">Cadastro</span><span class="admin-modal-val">${u.created_at?new Date(u.created_at).toLocaleString('pt-BR'):'—'}</span></div>
    <div class="admin-modal-row"><span class="admin-modal-key">Status</span><span class="admin-modal-val" style="color:${u.banned?'#f87171':'#00ff9d'}">${u.banned?'⛔ Banido':'✅ Ativo'}</span></div>
    <div class="admin-modal-row"><span class="admin-modal-key">Tipo</span><span class="admin-modal-val">${esc(formatTipoConta(u))}</span></div>
    ${u.materia ? `<div class="admin-modal-row"><span class="admin-modal-key">Matéria</span><span class="admin-modal-val">${esc(u.materia)}</span></div>` : ''}
    ${u.serie ? `<div class="admin-modal-row"><span class="admin-modal-key">Série/Turma</span><span class="admin-modal-val">${esc(u.serie)} ${esc(u.turma||'')}</span></div>` : ''}
    <div class="admin-modal-row"><span class="admin-modal-key">Nível</span><span class="admin-modal-val">${getLevelPill(g.totalMsgs||0)}</span></div>
    <div class="admin-modal-row"><span class="admin-modal-key">Mensagens</span><span class="admin-modal-val" style="font-family:'JetBrains Mono',monospace">${g.totalMsgs||0}</span></div>
    <div class="admin-modal-row"><span class="admin-modal-key">Quizzes</span><span class="admin-modal-val" style="font-family:'JetBrains Mono',monospace">${g.quizzesCompleted||0}</span></div>
    <div class="admin-modal-row"><span class="admin-modal-key">Streak</span><span class="admin-modal-val" style="font-family:'JetBrains Mono',monospace">${g.streak||0}</span></div>
    <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
      ${u.banned?`<button class="admin-action-btn" style="padding:8px 14px;font-size:12px;border-color:rgba(0,255,157,0.3);color:#00ff9d" onclick="adminUnbanUser('${uid}','${esc(u.name||u.email)}')">✅ Desbanir</button>`:`<button class="admin-action-btn ban" style="padding:8px 14px;font-size:12px" onclick="adminBanUser('${uid}','${esc(u.name||u.email)}')">⛔ Banir</button>`}
      <button class="admin-action-btn view" style="padding:8px 14px;font-size:12px" onclick="closeAdminUserModal();openRoleModal('${uid}')">✏️ Alterar tipo</button>
      <button class="admin-action-btn" style="padding:8px 14px;font-size:12px" onclick="adminResetXP('${uid}','${esc(u.name||u.email)}')">🔄 Resetar XP</button>
      ${!u.is_admin?`<button class="admin-action-btn" style="padding:8px 14px;font-size:12px;border-color:rgba(168,85,247,0.3);color:#a855f7" onclick="adminPromoteUser('${uid}','${esc(u.name||u.email)}')">🛡️ Tornar Admin</button>`:''}
      ${!u.is_admin?`<button class="admin-action-btn del" style="padding:8px 14px;font-size:12px" onclick="adminDeleteUser('${uid}','${esc(u.name||u.email)}')">🗑️ Apagar</button>`:''}
    </div>`;
  overlay.classList.remove('hidden');
}

function closeAdminUserModal() { document.getElementById('adminUserModal').classList.add('hidden'); }

/* ─── ADMIN ACTIONS (Supabase only) ─── */
async function adminBanUser(uid, name) {
  if (!confirm('⚠️ Banir "'+name+'"?')) return;
  const { error } = await sb.from('users').update({ banned: true }).eq('id', uid);
  if (error) { showToast('❌ Erro: '+error.message, 'error'); setTimeout(hideToast,3000); return; }
  await DB.logActivity(currentUser.id, 'admin', `BANIDO: ${name}`);
  const u = adminAllUsers.find(x=>x.id===uid); if(u) u.banned = true;
  renderAdminUsersTable(); renderAdminOverview(); closeAdminUserModal();
  showToast('⛔ '+name+' foi banido', 'success'); setTimeout(hideToast, 3000);
}

async function adminUnbanUser(uid, name) {
  const { error } = await sb.from('users').update({ banned: false }).eq('id', uid);
  if (error) { showToast('❌ Erro: '+error.message, 'error'); setTimeout(hideToast,3000); return; }
  await DB.logActivity(currentUser.id, 'admin', `DESBANIDO: ${name}`);
  const u = adminAllUsers.find(x=>x.id===uid); if(u) u.banned = false;
  renderAdminUsersTable(); renderAdminOverview(); closeAdminUserModal();
  showToast('✅ '+name+' foi desbanido', 'success'); setTimeout(hideToast, 3000);
}

async function adminDeleteUser(uid, name) {
  if (!confirm('⚠️ APAGAR a conta de "'+name+'"?\n\nEsta ação é irreversível.')) return;
  const { error } = await sb.from('users').delete().eq('id', uid);
  if (error) { showToast('❌ Erro: '+error.message, 'error'); setTimeout(hideToast,3000); return; }
  await DB.logActivity(currentUser.id, 'admin', `APAGADO: ${name}`);
  adminAllUsers = adminAllUsers.filter(u=>u.id!==uid);
  renderAdminUsersTable(); renderAdminOverview(); closeAdminUserModal();
  showToast('🗑️ Conta de '+name+' removida', 'success'); setTimeout(hideToast, 3000);
}

async function adminPromoteUser(uid, name) {
  if ((currentUser?.email || '').toLowerCase() !== SUPREME_ADMIN_EMAIL) {
    showToast('❌ Apenas o administrador supremo pode promover admins', 'error');
    setTimeout(hideToast, 3000);
    return;
  }
  if (!confirm('🛡️ Tornar "'+name+'" administrador?')) return;
  const { error } = await sb.from('users').update({ is_admin: true, tipo_conta: 'admin' }).eq('id', uid);
  if (error) { showToast('❌ Erro: '+error.message, 'error'); setTimeout(hideToast,3000); return; }
  await DB.logActivity(currentUser.id, 'admin', `PROMOVIDO a admin: ${name}`);
  const u = adminAllUsers.find(x=>x.id===uid); if(u) u.is_admin = true;
  await loadAdminData(); closeAdminUserModal();
  showToast('🛡️ '+name+' agora é admin!', 'success'); setTimeout(hideToast, 3000);
}

async function adminResetXP(uid, name) {
  if (!confirm('🔄 Resetar XP de "'+name+'"?')) return;
  const reset = {totalMsgs:0,quizzesCompleted:0,quizScores:[],subjectCounts:{},streak:0,weeklyActivity:[0,0,0,0,0,0,0],lastActiveDay:'',weekStart:''};
  const { error } = await sb.from('users').update({ gamification: reset }).eq('id', uid);
  if (error) { showToast('❌ Erro: '+error.message, 'error'); setTimeout(hideToast,3000); return; }
  await DB.logActivity(currentUser.id, 'admin', `XP RESETADO: ${name}`);
  const u = adminAllUsers.find(x=>x.id===uid); if(u) u.gamification = reset;
  renderAdminUsersTable(); renderAdminOverview(); closeAdminUserModal();
  showToast('🔄 XP de '+name+' resetado', 'success'); setTimeout(hideToast, 3000);
}

/* ─── BROADCAST ─── */
async function sendBroadcast() {
  const title = document.getElementById('broadcastTitle')?.value.trim();
  const msg   = document.getElementById('broadcastMsg')?.value.trim();
  if (!title || !msg) { showToast('⚠️ Preencha título e mensagem', 'error'); setTimeout(hideToast,3000); return; }
  try {
    await sb.from('broadcasts').insert({ title, message: msg, created_by: currentUser.id, created_at: new Date().toISOString(), active: true });
    showToast('📢 Anúncio publicado!', 'success');
  } catch(e) {
    await DB.logActivity(currentUser.id, 'broadcast', `[${title}] ${msg}`);
    showToast('📢 Anúncio registrado!', 'success');
  }
  setTimeout(hideToast, 3000);
  if(document.getElementById('broadcastTitle')) document.getElementById('broadcastTitle').value='';
  if(document.getElementById('broadcastMsg')) document.getElementById('broadcastMsg').value='';
  renderBroadcastList();
}

async function renderBroadcastList() {
  const el = document.getElementById('broadcastList'); if(!el)return;
  try {
    const { data } = await sb.from('broadcasts').select('*').order('created_at',{ascending:false}).limit(10);
    if (!data?.length) { el.innerHTML='<div style="color:var(--text-muted);font-size:12px">Nenhum anúncio ativo.</div>'; return; }
    el.innerHTML = data.map(b=>`<div style="padding:14px;background:#0d1220;border:1px solid #1a2540;border-radius:12px;margin-bottom:10px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><strong style="color:#dde6f5;font-family:'Syne',sans-serif">${esc(b.title)}</strong><span style="font-size:10px;color:#3d5070;font-family:'JetBrains Mono',monospace">${new Date(b.created_at).toLocaleDateString('pt-BR')}</span></div><div style="font-size:13px;color:#8aa0c0">${esc(b.message)}</div></div>`).join('');
  } catch(e) { el.innerHTML='<div style="color:var(--text-muted);font-size:12px">Tabela broadcasts não configurada.</div>'; }
}

function adminExportData() {
  const data = { exportedAt: new Date().toISOString(), users: adminAllUsers.map(u=>({name:u.name,email:u.email,id:u.id,level:getLevel(u.gamification?.totalMsgs||0),messages:u.gamification?.totalMsgs||0,quizzes:u.gamification?.quizzesCompleted||0,isAdmin:u.is_admin||false,banned:u.banned||false})) };
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const a = document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='prof_roberto_export_'+new Date().toLocaleDateString('pt-BR').replace(/\//g,'-')+'.json'; a.click();
  showToast('📥 Dados exportados!', 'success'); setTimeout(hideToast, 2500);
}

/* ═══════════════════════════════════════
   TOGGLE REGISTER FIELDS
═══════════════════════════════════════ */
function setRegTipo(tipo) {
  const hidden = document.getElementById('regTipoConta');
  if (hidden) hidden.value = tipo;
  document.querySelectorAll('.auth-type-pill').forEach((pill) => {
    pill.classList.toggle('active', pill.dataset.tipo === tipo);
  });
  toggleRegFields();
}

function formatTipoConta(u) {
  const t = u?.tipo_conta || (u?.is_admin ? 'admin' : 'aluno');
  if (t === 'professor') return '👨‍🏫 Professor';
  if (t === 'super_admin') return '⚡ Super Admin';
  if (t === 'admin' || u?.is_admin) return '🛡️ Admin';
  return '👩‍🎓 Aluno';
}

function toggleRegFields() {
  const tipo = document.getElementById('regTipoConta')?.value || 'aluno';
  const alunoFields = document.getElementById('regAlunoFields');
  const profFields  = document.getElementById('regProfFields');
  const hintAluno   = document.getElementById('regHintAluno');
  const hintProf    = document.getElementById('regHintProf');
  const isAluno = tipo === 'aluno';
  if (alunoFields) alunoFields.classList.toggle('hidden', !isAluno);
  if (profFields)  profFields.classList.toggle('hidden', isAluno);
  if (hintAluno)   hintAluno.classList.toggle('hidden', !isAluno);
  if (hintProf)    hintProf.classList.toggle('hidden', isAluno);
}

/* ═══════════════════════════════════════
   PROFESSOR PANEL
═══════════════════════════════════════ */
function openProfessorPanel() {
  const tipo = currentUser?.tipo_conta;
  if (tipo !== 'professor' && !currentUser?.is_admin) {
    showToast('⛔ Acesso negado', 'error'); setTimeout(hideToast, 2500); return;
  }
  document.getElementById('professor-screen').classList.remove('hidden');
  // Exibe matéria no badge
  const badge = document.getElementById('profBadgeMateria');
  if (badge) badge.textContent = currentUser.materia || 'Professor';
  // Pré-seleciona matéria do professor nos selects de geração
  if (currentUser.materia) prefillMateriaProf(currentUser.materia);
  toggleUserDropdown(false);
  loadProfData();
}

function prefillMateriaProf(materia) {
  // Modo aula
  const maEl = document.getElementById('maMateria');
  if (maEl) {
    Array.from(maEl.options).forEach(o => { if (o.value === materia) o.selected = true; });
  }
}

function closeProfessorPanel() {
  document.getElementById('professor-screen').classList.add('hidden');
}

function switchProfView(view) {
  closeAdminNav('professor-screen');
  document.querySelectorAll('#professor-screen .admin-view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('#professor-screen .admin-nav-item').forEach(i => i.classList.remove('active'));
  const viewEl = document.getElementById('prof-view-'+view);
  if (viewEl) viewEl.classList.add('active');
  const navEl = document.querySelector(`#professor-screen .admin-nav-item[data-pview="${view}"]`);
  if (navEl) navEl.classList.add('active');
  if (view === 'avisos')    loadAvisosProf();
  if (view === 'stats-prof') loadProfStats();
  if (view === 'modo-aula') loadModoAulaHistorico();
}

async function loadProfData() {
  loadAvisosProf();
  loadAtividadesList();
}

/* ── Gerar Atividade ── */
async function gerarAtividade() {
  const serie      = document.getElementById('atSerie')?.value || '';
  const turma      = document.getElementById('atTurma')?.value || '';
  const assunto    = document.getElementById('atAssunto')?.value.trim() || '';
  const dificuldade= document.getElementById('atDificuldade')?.value || 'média';
  const qtd        = document.getElementById('atQtd')?.value || '10';
  const materia    = currentUser?.materia || 'Geral';
  const btn        = document.getElementById('atGenBtn');
  const area       = document.getElementById('atResultArea');

  if (!assunto) { showToast('⚠️ Informe o assunto', 'error'); setTimeout(hideToast,2500); return; }
  btn.disabled = true; btn.textContent = '⏳ Gerando...';
  area.innerHTML = '<div class="spinner"></div>';

  const prompt = `Crie uma atividade educacional com ${qtd} questões sobre "${assunto}" de ${materia} para alunos do ${serie} turma ${turma}.
Dificuldade: ${dificuldade}. Adapte linguagem e complexidade ao nível ${serie}.
Responda APENAS com JSON válido:
{"titulo":"Título da Atividade","descricao":"breve descrição","questoes":[{"numero":1,"enunciado":"texto","tipo":"dissertativa OU multipla_escolha","opcoes":["A) ...","B) ...","C) ...","D) ..."],"gabarito":"resposta ou índice 0-3"}]}`;

  try {
    const { reply } = await callAI(`Você é um especialista em criação de atividades educacionais brasileiras. Responda APENAS com JSON válido.`, [{role:'user',parts:[{text:prompt}]}], 0.7);
    let clean = reply.trim().replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
    const s=clean.indexOf('{'),e=clean.lastIndexOf('}'); if(s>=0&&e>s) clean=clean.substring(s,e+1);
    const data = JSON.parse(clean);

    // Salva no banco
    await sb.from('atividades').insert({
      professor_id: currentUser.id,
      materia, serie, turma, assunto, dificuldade,
      titulo: data.titulo,
      conteudo: JSON.stringify(data),
      created_at: new Date().toISOString()
    });

    // Renderiza
    area.innerHTML = `<div class="admin-stat-card">
      <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:800;color:var(--text);margin-bottom:6px">${esc(data.titulo)}</div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:14px">${esc(data.descricao||'')} · ${serie} ${turma} · ${materia}</div>
      ${(data.questoes||[]).map((q,i) => `
        <div style="margin-bottom:14px;padding:14px;background:var(--surface2);border:1px solid var(--border);border-radius:10px">
          <div style="font-size:12px;font-weight:700;color:var(--cyan);margin-bottom:6px">Questão ${q.numero||i+1}</div>
          <div style="font-size:13px;color:var(--text);margin-bottom:8px">${esc(q.enunciado)}</div>
          ${q.opcoes ? q.opcoes.map(o=>`<div style="font-size:12px;color:var(--text-dim);padding:3px 0">${esc(o)}</div>`).join('') : ''}
          ${q.gabarito !== undefined ? `<div style="font-size:11px;color:var(--green);margin-top:6px;font-weight:700">Gabarito: ${esc(String(q.gabarito))}</div>` : ''}
        </div>`).join('')}
      <div style="color:var(--green);font-size:13px;font-weight:700;margin-top:8px">✅ Atividade salva no banco!</div>
    </div>`;
    showToast('✅ Atividade gerada e salva!', 'success'); setTimeout(hideToast, 3000);
    loadAtividadesList();
  } catch(e) {
    area.innerHTML = `<div style="color:var(--red);padding:20px">❌ Erro: ${esc(e.message)}</div>`;
  }
  btn.disabled = false; btn.textContent = '⚡ Gerar Atividade com IA';
}

async function loadAtividadesList() {
  const el = document.getElementById('atListArea'); if(!el) return;
  try {
    const { data } = await sb.from('atividades')
      .select('id,titulo,serie,turma,assunto,dificuldade,created_at')
      .eq('professor_id', currentUser.id)
      .order('created_at',{ascending:false}).limit(20);
    if (!data?.length) { el.innerHTML='<div style="color:var(--text-muted);font-size:12px">Nenhuma atividade criada ainda.</div>'; return; }
    el.innerHTML = data.map(a => `
      <div style="padding:14px;background:var(--surface);border:1px solid var(--border);border-radius:12px;margin-bottom:10px;display:flex;align-items:center;gap:12px">
        <div style="flex:1">
          <div style="font-family:'Syne',sans-serif;font-size:14px;font-weight:800;color:var(--text)">${esc(a.titulo||a.assunto)}</div>
          <div style="font-size:11px;color:var(--text-muted)">${esc(a.serie)} ${esc(a.turma)} · ${esc(a.dificuldade||'')} · ${new Date(a.created_at).toLocaleDateString('pt-BR')}</div>
        </div>
        <button class="admin-action-btn del" onclick="deletarAtividade('${a.id}')">🗑️</button>
      </div>`).join('');
  } catch(e) { el.innerHTML=`<div style="color:var(--text-muted);font-size:12px">Tabela 'atividades' não configurada. Execute o SQL de setup.</div>`; }
}

async function deletarAtividade(id) {
  if (!confirm('Apagar esta atividade?')) return;
  await sb.from('atividades').delete().eq('id', id);
  loadAtividadesList();
  showToast('🗑️ Atividade removida', 'success'); setTimeout(hideToast, 2000);
}

/* ── Quiz para Turma ── */
async function gerarQuizProf() {
  const serie      = document.getElementById('qpSerie')?.value || '';
  const turma      = document.getElementById('qpTurma')?.value || '';
  const assunto    = document.getElementById('qpAssunto')?.value.trim() || '';
  const dificuldade= document.getElementById('qpDificuldade')?.value || 'média';
  const materia    = currentUser?.materia || 'Geral';
  const btn        = document.getElementById('qpGenBtn');
  const area       = document.getElementById('qpResultArea');

  if (!assunto) { showToast('⚠️ Informe o assunto', 'error'); setTimeout(hideToast,2500); return; }
  btn.disabled = true; btn.textContent = '⏳ Gerando...';
  area.innerHTML = '<div class="spinner"></div>';

  const prompt = `Gere 5 questões de múltipla escolha sobre "${assunto}" de ${materia} para ${serie} turma ${turma}. Dificuldade: ${dificuldade}.
RESPONDA APENAS com JSON: {"questions":[{"question":"texto","options":["A) texto","B) texto","C) texto","D) texto"],"correct":0,"explanation":"explicação"}]}`;

  try {
    const { reply } = await callAI(`Você é um gerador de quizzes educacionais. Responda APENAS com JSON válido.`, [{role:'user',parts:[{text:prompt}]}], 0.7);
    let clean = reply.trim().replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
    const s=clean.indexOf('{'),e=clean.lastIndexOf('}'); if(s>=0&&e>s) clean=clean.substring(s,e+1);
    const data = JSON.parse(clean);

    // Salva como atividade do tipo quiz
    await sb.from('atividades').insert({
      professor_id: currentUser.id,
      materia, serie, turma, assunto, dificuldade,
      titulo: `Quiz: ${assunto}`,
      tipo: 'quiz',
      conteudo: JSON.stringify(data),
      created_at: new Date().toISOString()
    });

    area.innerHTML = `<div class="admin-stat-card"><div style="font-family:'Syne',sans-serif;font-size:16px;font-weight:800;color:var(--text);margin-bottom:14px">Quiz: ${esc(assunto)}</div>
      ${(data.questions||[]).map((q,i) => `
        <div style="margin-bottom:12px;padding:12px;background:var(--surface2);border:1px solid var(--border);border-radius:10px">
          <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:8px">${i+1}. ${esc(q.question)}</div>
          ${(q.options||[]).map((o,j)=>`<div style="font-size:12px;color:${j===q.correct?'var(--green)':'var(--text-dim)'};padding:2px 0">${j===q.correct?'✅ ':''}${esc(o)}</div>`).join('')}
          <div style="font-size:11px;color:var(--text-muted);margin-top:6px">${esc(q.explanation||'')}</div>
        </div>`).join('')}
      <div style="color:var(--green);font-size:13px;font-weight:700">✅ Quiz salvo!</div>
    </div>`;
    showToast('✅ Quiz gerado e salvo!', 'success'); setTimeout(hideToast, 3000);
  } catch(e) {
    area.innerHTML = `<div style="color:var(--red);padding:20px">❌ Erro: ${esc(e.message)}</div>`;
  }
  btn.disabled = false; btn.textContent = '⚡ Gerar Quiz com IA';
}

/* ── Avisos ── */
async function publicarAviso() {
  const titulo  = document.getElementById('avTitulo')?.value.trim();
  const mensagem= document.getElementById('avMensagem')?.value.trim();
  const serie   = document.getElementById('avSerie')?.value || 'Todas';
  const turma   = document.getElementById('avTurma')?.value || 'Todas';
  if (!titulo || !mensagem) { showToast('⚠️ Preencha título e mensagem', 'error'); setTimeout(hideToast,2500); return; }

  try {
    await sb.from('avisos').insert({
      professor_id: currentUser.id,
      professor_nome: currentUser.name,
      materia: currentUser.materia || '',
      serie, turma, titulo, mensagem,
      created_at: new Date().toISOString(),
      ativo: true
    });
    showToast('📢 Aviso publicado!', 'success'); setTimeout(hideToast, 3000);
    document.getElementById('avTitulo').value = '';
    document.getElementById('avMensagem').value = '';
    loadAvisosProf();
  } catch(e) {
    showToast('❌ Erro ao publicar: ' + e.message, 'error'); setTimeout(hideToast, 3000);
  }
}

async function loadAvisosProf() {
  const el = document.getElementById('avListArea'); if(!el) return;
  try {
    const { data } = await sb.from('avisos')
      .select('*').eq('professor_id', currentUser.id)
      .order('created_at',{ascending:false}).limit(20);
    if (!data?.length) { el.innerHTML='<div style="color:var(--text-muted);font-size:12px">Nenhum aviso publicado ainda.</div>'; return; }
    el.innerHTML = data.map(a => `
      <div style="padding:14px;background:var(--surface);border:1px solid var(--border);border-radius:12px;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
          <strong style="color:var(--text);font-family:'Syne',sans-serif">${esc(a.titulo)}</strong>
          <span style="font-size:10px;color:var(--cyan);background:rgba(0,212,255,0.08);border:1px solid rgba(0,212,255,0.2);padding:2px 8px;border-radius:20px">${esc(a.serie)} ${esc(a.turma)}</span>
          <span style="margin-left:auto;font-size:10px;color:var(--text-muted)">${new Date(a.created_at).toLocaleDateString('pt-BR')}</span>
        </div>
        <div style="font-size:13px;color:var(--text-dim)">${esc(a.mensagem)}</div>
        <button class="admin-action-btn del" style="margin-top:8px" onclick="deletarAviso('${a.id}')">🗑️ Remover</button>
      </div>`).join('');
  } catch(e) { el.innerHTML=`<div style="color:var(--text-muted);font-size:12px">Tabela 'avisos' não configurada. Execute o SQL de setup.</div>`; }
}

async function deletarAviso(id) {
  if (!confirm('Remover este aviso?')) return;
  await sb.from('avisos').delete().eq('id', id);
  loadAvisosProf();
  showToast('🗑️ Aviso removido', 'success'); setTimeout(hideToast, 2000);
}

/* ── Avisos para Alunos ── */
async function loadAvisosAluno() {
  const el = document.getElementById('avisosAlunoList'); if(!el) return;
  try {
    let query = sb.from('avisos').select('*').eq('ativo', true).order('created_at',{ascending:false});
    // Filtra por série/turma do aluno
    const serie = currentUser?.serie;
    const turma = currentUser?.turma;
    const { data } = await query;
    const filtrado = (data||[]).filter(a =>
      (a.serie === 'Todas' || a.serie === serie) &&
      (a.turma === 'Todas' || a.turma === turma)
    );
    if (!filtrado.length) { el.innerHTML='<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:32px">Nenhum aviso no momento 📭</div>'; return; }
    el.innerHTML = filtrado.map(a => `
      <div style="padding:16px;background:var(--surface);border:1px solid rgba(0,212,255,0.15);border-radius:14px;margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <span style="font-size:18px">📢</span>
          <div>
            <div style="font-family:'Syne',sans-serif;font-size:15px;font-weight:800;color:var(--text)">${esc(a.titulo)}</div>
            <div style="font-size:11px;color:var(--text-muted)">${esc(a.professor_nome||'Professor')} · ${esc(a.materia||'')} · ${new Date(a.created_at).toLocaleDateString('pt-BR')}</div>
          </div>
        </div>
        <div style="font-size:13px;color:var(--text-dim);line-height:1.6">${esc(a.mensagem)}</div>
      </div>`).join('');
  } catch(e) { el.innerHTML='<div style="color:var(--text-muted);font-size:12px;padding:20px">Avisos não disponíveis.</div>'; }
}

/* ── Atividades e quizzes dos professores (área do aluno) ── */
let atividadesAluno = [];
let atividadeAtual = null;

/** Converte os dois formatos salvos (atividade: questoes/enunciado/gabarito | quiz: questions/question/correct). */
function normalizarAtividade(row) {
  let c = {};
  try { c = JSON.parse(row.conteudo || '{}'); } catch(e) { console.warn('conteudo inválido', e); }
  const lista = c.questions || c.questoes || [];
  const questoes = lista.map((q, i) => {
    const enunciado = q.question || q.enunciado || '';
    const opcoes = Array.isArray(q.options) ? q.options : (Array.isArray(q.opcoes) ? q.opcoes : []);
    const multipla = opcoes.length >= 2 && q.tipo !== 'dissertativa';
    const bruto = q.correct !== undefined ? q.correct : q.gabarito;
    let correta = null;
    if (multipla && bruto !== undefined && bruto !== null) {
      const g = String(bruto).trim();
      if (typeof bruto === 'number' || /^\d+$/.test(g)) correta = Number(g);
      else if (/^[A-Da-d]([\).\s]|$)/.test(g)) correta = 'ABCD'.indexOf(g[0].toUpperCase());
      else { const k = opcoes.findIndex(o => o.toLowerCase().includes(g.toLowerCase())); correta = k >= 0 ? k : null; }
      if (correta !== null && (correta < 0 || correta >= opcoes.length)) correta = null;
    }
    return {
      numero: q.numero || i + 1,
      tipo: multipla ? 'mc' : 'open',
      enunciado, opcoes, correta,
      explicacao: q.explanation || '',
      gabarito: (!multipla && bruto !== undefined) ? String(bruto) : ''
    };
  }).filter(q => q.enunciado);
  return { id: row.id, titulo: row.titulo || row.assunto || 'Atividade', materia: row.materia || '', tipo: row.tipo || 'atividade',
           descricao: c.descricao || '', questoes, resp: new Array(questoes.length).fill(null), enviada: false, dbId: null };
}

async function loadAtividadesAluno() {
  const el = document.getElementById('atividadesAlunoList'); if (!el) return;
  const player = document.getElementById('atividadeAlunoPlayer'); if (player) player.innerHTML = '';
  if (!currentUser) { el.innerHTML = '<div style="color:var(--text-muted);font-size:12px">Faça login para ver suas atividades.</div>'; return; }
  const { serie, turma } = currentUser;
  if (!serie || !turma) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:32px">Seu cadastro não tem série/turma, então não há atividades para mostrar. 📭</div>';
    return;
  }
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const { data, error } = await sb.from('atividades')
      .select('id,titulo,materia,serie,turma,assunto,dificuldade,tipo,conteudo,created_at')
      .eq('serie', serie).eq('turma', turma)
      .order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    atividadesAluno = data || [];
    if (!atividadesAluno.length) { el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:32px">Nenhuma atividade para a sua turma no momento 📭</div>'; return; }
    el.innerHTML = atividadesAluno.map(a => `
      <div style="padding:16px;background:var(--surface);border:1px solid rgba(0,212,255,0.15);border-radius:14px;margin-bottom:12px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <span style="font-size:22px">${a.tipo === 'quiz' ? '🎯' : '📚'}</span>
        <div style="flex:1;min-width:160px">
          <div style="font-family:'Syne',sans-serif;font-size:15px;font-weight:800;color:var(--text)">${esc(a.titulo || a.assunto || 'Atividade')}</div>
          <div style="font-size:11px;color:var(--text-muted)">${esc(a.materia || '')} · ${esc(a.dificuldade || '')} · ${new Date(a.created_at).toLocaleDateString('pt-BR')}</div>
        </div>
        <button class="quiz-submit-btn" style="margin:0;width:auto;padding:8px 18px" onclick="abrirAtividadeAluno('${a.id}')">Fazer →</button>
      </div>`).join('');
  } catch(e) {
    console.warn('loadAtividadesAluno', e);
    el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:20px">Atividades indisponíveis no momento. Se o problema persistir, peça ao administrador para liberar a leitura da tabela <b>atividades</b> aos alunos (RLS).</div>';
  }
}

function abrirAtividadeAluno(id) {
  const row = atividadesAluno.find(a => String(a.id) === String(id)); if (!row) return;
  atividadeAtual = normalizarAtividade(row);
  if (!atividadeAtual.questoes.length) { showToast('⚠️ Esta atividade não tem questões', 'error'); setTimeout(hideToast, 2500); return; }
  renderAtividadeAluno();
  document.getElementById('atividadeAlunoPlayer').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderAtividadeAluno() {
  const at = atividadeAtual; if (!at) return;
  const box = document.getElementById('atividadeAlunoPlayer');
  box.innerHTML = `
    <div style="margin:18px 0 12px;display:flex;align-items:center;gap:10px">
      <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:800;color:var(--text);flex:1">${esc(at.titulo)}</div>
      <button class="admin-action-btn" onclick="fecharAtividadeAluno()">✕ Fechar</button>
    </div>
    ${at.descricao ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">${esc(at.descricao)}</div>` : ''}
    ${at.questoes.map((q, i) => `
      <div class="quiz-card">
        <div class="quiz-q-num">Questão ${i + 1} de ${at.questoes.length}</div>
        <div class="quiz-q-text">${esc(q.enunciado)}</div>
        ${q.tipo === 'mc'
          ? `<div class="quiz-options">${q.opcoes.map((o, j) => `<button class="quiz-opt" onclick="selecionarOpcaoAtividade(${i},${j})">${esc(o)}</button>`).join('')}</div>`
          : `<textarea class="auth-input" id="atResp-${i}" rows="3" placeholder="Escreva sua resposta..." style="width:100%;resize:vertical"></textarea>`}
        <div class="quiz-explanation" id="atExp-${i}"></div>
      </div>`).join('')}
    <button class="quiz-submit-btn" id="atEnviarBtn" onclick="enviarAtividadeAluno()">✅ Enviar respostas</button>
    <div id="atResultado"></div>`;
}

function fecharAtividadeAluno() { atividadeAtual = null; document.getElementById('atividadeAlunoPlayer').innerHTML = ''; }

function selecionarOpcaoAtividade(qIdx, optIdx) {
  if (!atividadeAtual || atividadeAtual.enviada) return;
  atividadeAtual.resp[qIdx] = optIdx;
  const card = document.getElementById('atividadeAlunoPlayer').querySelectorAll('.quiz-card')[qIdx];
  card.querySelectorAll('.quiz-opt').forEach((b, i) => b.classList.toggle('selected', i === optIdx));
}

async function enviarAtividadeAluno() {
  const at = atividadeAtual; if (!at || at.enviada) return;
  at.enviada = true;
  const btn = document.getElementById('atEnviarBtn'); if (btn) btn.disabled = true;
  const cards = document.getElementById('atividadeAlunoPlayer').querySelectorAll('.quiz-card');
  let acertos = 0, objetivas = 0;
  at.questoes.forEach((q, i) => {
    const exp = document.getElementById('atExp-' + i);
    if (q.tipo === 'mc') {
      const opts = cards[i].querySelectorAll('.quiz-opt');
      if (q.correta !== null) {
        objetivas++;
        opts.forEach((b, j) => { if (j === q.correta) b.classList.add('correct'); else if (j === at.resp[i]) b.classList.add('wrong'); });
        if (at.resp[i] === q.correta) acertos++;
      }
      if (exp && q.explicacao) { exp.textContent = q.explicacao; exp.classList.add('show'); }
    } else {
      const ta = document.getElementById('atResp-' + i); if (ta) ta.disabled = true;
      if (exp && q.gabarito) { exp.textContent = 'Resposta de referência: ' + q.gabarito; exp.classList.add('show'); }
    }
  });

  const abertas = at.questoes.filter(q => q.tipo === 'open').length;
  const pct = objetivas ? acertos / objetivas : null;
  document.getElementById('atResultado').innerHTML = objetivas
    ? `<div class="quiz-score-bar" style="margin-top:14px"><span style="font-size:32px;font-family:'JetBrains Mono',monospace;font-weight:600;color:${pct>=0.7?'#00ff9d':pct>=0.5?'#fbbf24':'#f87171'}">${acertos}/${objetivas}</span><div><div style="font-family:'Syne',sans-serif;font-size:16px;font-weight:800;color:var(--text)">${Math.round(pct*100)}% de acerto</div>${abertas ? `<div style="font-size:12px;color:var(--text-muted)">${abertas} questão(ões) dissertativa(s) não entram na nota automática</div>` : ''}</div></div>`
    : `<div style="margin-top:14px;color:var(--green);font-weight:700;font-size:13px">✅ Respostas enviadas! Compare com as respostas de referência.</div>`;

  // Gamificação + banco (apenas atividades com questões objetivas geram nota)
  const g = state.gamification;
  g.quizzesCompleted++;
  if (pct !== null) g.quizScores.push(pct);
  touchStreak();
  updateGamificationUI();
  if (currentUser) {
    if (objetivas) at.dbId = await DB.saveQuizResult(currentUser.id, `${at.tipo === 'quiz' ? 'Quiz' : 'Atividade'}: ${at.titulo}`.substring(0, 120), acertos, objetivas);
    await DB.logActivity(currentUser.id, 'quiz', `${at.tipo === 'quiz' ? 'Quiz' : 'Atividade'} do professor: ${at.titulo}`);
    DB.saveGamification(currentUser.id, g);
  }
}

/* ── Estatísticas do Professor ── */
async function loadProfStats() {
  const serie = document.getElementById('statsSerie')?.value || 'Todas';
  const turma = document.getElementById('statsTurma')?.value || 'Todas';

  try {
    // Busca alunos da turma
    let q = sb.from('users').select('*').eq('tipo_conta', 'aluno');
    if (serie !== 'Todas') q = q.eq('serie', serie);
    if (turma !== 'Todas') q = q.eq('turma', turma);
    const { data: alunos } = await q;

    // Busca atividades do professor
    const { data: ats } = await sb.from('atividades')
      .select('id,created_at').eq('professor_id', currentUser.id);

    // Busca quiz_history dos alunos dessa turma
    const alunoIds = (alunos||[]).map(a=>a.id);
    let quizMedia = '—';
    if (alunoIds.length) {
      const { data: quizzes } = await sb.from('quiz_history')
        .select('accuracy').in('user_id', alunoIds);
      if (quizzes?.length) {
        const med = quizzes.reduce((s,q)=>s+(q.accuracy||0),0)/quizzes.length;
        quizMedia = Math.round(med*100)+'%';
      }
    }

    document.getElementById('pstat-alunos').textContent = alunos?.length || 0;
    document.getElementById('pstat-quizzes').textContent = alunoIds.length
      ? (await sb.from('quiz_history').select('id',{count:'exact'}).in('user_id',alunoIds)).count || '—'
      : 0;
    document.getElementById('pstat-media').textContent = quizMedia;
    document.getElementById('pstat-atividades').textContent = ats?.length || 0;

    // Lista alunos
    const listEl = document.getElementById('profAlunosList');
    if (listEl) {
      listEl.innerHTML = (alunos||[]).length ? (alunos||[]).map(a => `
        <div style="display:flex;align-items:center;gap:12px;padding:10px;background:var(--surface);border:1px solid var(--border);border-radius:10px;margin-bottom:8px">
          <div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,var(--cyan),var(--purple));display:flex;align-items:center;justify-content:center;font-family:'Syne',sans-serif;font-weight:800;color:#050810;font-size:14px">${(a.name||'?').charAt(0).toUpperCase()}</div>
          <div style="flex:1"><div style="font-weight:700;color:var(--text);font-size:13px">${esc(a.name||'—')}</div><div style="font-size:11px;color:var(--text-muted)">${esc(a.serie||'')} ${esc(a.turma||'')}</div></div>
          <span style="font-size:10px;color:var(--cyan);font-family:'JetBrains Mono',monospace">${a.gamification?.totalMsgs||0} msgs</span>
        </div>`).join('')
      : '<div style="color:var(--text-muted);font-size:12px">Nenhum aluno encontrado para essa seleção.</div>';
    }
  } catch(e) { console.warn('loadProfStats', e); }
}

/* ── Modo Aula ── */
/** Marca aula(s) como encerradas no banco. Sem id, encerra todas as aulas ativas do professor. */
async function encerrarAulaNoBanco(id) {
  if (!currentUser) return false;
  const agora = new Date().toISOString();
  const run = (payload) => {
    let q = sb.from('aulas_ativas').update(payload);
    q = id ? q.eq('id', id) : q.eq('professor_id', currentUser.id).eq('ativa', true);
    return q;
  };
  try {
    let { error } = await run({ ativa: false, encerrada_em: agora });
    if (error) { // coluna encerrada_em pode ainda não existir: marca ao menos como inativa
      console.warn('encerrarAula (com encerrada_em):', error.message);
      ({ error } = await run({ ativa: false }));
    }
    if (error) { console.warn('encerrarAula:', error.message); return false; }
    return true;
  } catch(e) { console.warn('encerrarAulaNoBanco', e); return false; }
}

async function ativarModoAula() {
  const serie   = document.getElementById('maSerie')?.value   || '';
  const turma   = document.getElementById('maTurma')?.value   || '';
  const materia = document.getElementById('maMateria')?.value || '';

  // Fecha qualquer aula que tenha ficado aberta antes de abrir uma nova
  await encerrarAulaNoBanco(null);

  modoAulaAtivo = { serie, turma, materia };
  aulaAtivaId = null;

  // UI
  const banner = document.getElementById('modoAulaBanner');
  if (banner) { banner.style.display = 'flex'; }
  const labelEl = document.getElementById('modoAulaLabel');
  if (labelEl) labelEl.textContent = `${materia} — ${serie} ${turma}`;
  const statusEl = document.getElementById('modoAulaStatus');
  if (statusEl) statusEl.innerHTML = `<span style="color:var(--yellow);font-weight:700">🎓 ATIVO — ${esc(materia)} · ${esc(serie)} ${esc(turma)}</span>`;

  // Salva no banco e guarda o id para poder encerrar depois
  try {
    const { data, error } = await sb.from('aulas_ativas').insert({
      professor_id: currentUser.id,
      materia, serie, turma,
      iniciada_em: new Date().toISOString(),
      ativa: true
    }).select('id').single();
    if (error) console.warn('ativarModoAula:', error.message);
    aulaAtivaId = data?.id || null;
  } catch(e) { console.warn('ativarModoAula', e); }
  loadModoAulaHistorico();

  showToast('🎓 Modo aula ativado!', 'success'); setTimeout(hideToast, 3000);
  closeProfessorPanel();
}

async function desativarModoAula(silencioso = false) {
  const id = aulaAtivaId;
  modoAulaAtivo = null;
  aulaAtivaId = null;
  const banner = document.getElementById('modoAulaBanner');
  if (banner) banner.style.display = 'none';
  const statusEl = document.getElementById('modoAulaStatus');
  if (statusEl) statusEl.textContent = 'Modo aula inativo';

  // Atualiza o registro salvo (sem id, encerra as aulas ainda ativas do professor)
  const ok = await encerrarAulaNoBanco(id);
  if (!silencioso) {
    showToast(ok ? '⏹ Modo aula encerrado' : '⚠️ Aula encerrada aqui, mas não foi possível atualizar o banco', ok ? 'success' : 'error');
    setTimeout(hideToast, 2500);
  }
  loadModoAulaHistorico();
}

async function loadModoAulaHistorico() {
  const el = document.getElementById('maHistorico'); if(!el) return;
  try {
    const { data } = await sb.from('aulas_ativas').select('*')
      .eq('professor_id', currentUser.id)
      .order('iniciada_em',{ascending:false}).limit(10);
    if (!data?.length) { el.innerHTML='<div style="color:var(--text-muted);font-size:12px">Nenhuma aula iniciada ainda.</div>'; return; }
    el.innerHTML = data.map(a => `
      <div style="padding:12px;background:var(--surface);border:1px solid var(--border);border-radius:10px;margin-bottom:8px;display:flex;align-items:center;gap:10px">
        <span style="font-size:16px">🎓</span>
        <div style="flex:1">
          <div style="font-weight:700;color:var(--text);font-size:13px">${esc(a.materia)} — ${esc(a.serie)} ${esc(a.turma)}</div>
          <div style="font-size:11px;color:var(--text-muted)">${new Date(a.iniciada_em).toLocaleString('pt-BR')}${a.encerrada_em ? ' → ' + new Date(a.encerrada_em).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}) : ''}</div>
        </div>
        <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;${a.ativa ? 'color:var(--green);background:rgba(0,255,157,0.08);border:1px solid rgba(0,255,157,0.25)' : 'color:var(--text-muted);border:1px solid var(--border)'}">${a.ativa ? '🟢 Em andamento' : 'Encerrada'}</span>
      </div>`).join('');
  } catch(e) { el.innerHTML='<div style="color:var(--text-muted);font-size:12px">Tabela aulas_ativas não configurada.</div>'; }
}

/* ═══════════════════════════════════════
   SUPER ADMIN PANEL
═══════════════════════════════════════ */
let saAllUsers = [];

function openSuperAdminPanel() {
  const isSA = currentUser?.tipo_conta === 'super_admin' || currentUser?.email === SUPREME_ADMIN_EMAIL;
  if (!isSA) { showToast('⛔ Acesso negado', 'error'); setTimeout(hideToast, 2500); return; }
  document.getElementById('superadmin-screen').classList.remove('hidden');
  toggleUserDropdown(false);
  loadSuperAdminData();
}

function closeSuperAdminPanel() { document.getElementById('superadmin-screen').classList.add('hidden'); }

function switchSAView(view) {
  closeAdminNav('superadmin-screen');
  document.querySelectorAll('#superadmin-screen .admin-view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('#superadmin-screen .admin-nav-item').forEach(i => i.classList.remove('active'));
  const viewEl = document.getElementById('sa-view-'+view);
  if (viewEl) viewEl.classList.add('active');
  const navEl = document.querySelector(`#superadmin-screen .admin-nav-item[data-saview="${view}"]`);
  if (navEl) navEl.classList.add('active');
}

async function loadSuperAdminData() {
  try {
    const { data } = await sb.from('users').select('*').order('created_at',{ascending:false});
    saAllUsers = data || [];
  } catch(e) { saAllUsers = []; }
  renderSAProfessores();
  renderSAUsuarios();
  renderSATurmas();
}

function renderSAProfessores() {
  const tbody = document.getElementById('saProfBody'); if(!tbody) return;
  const profs = saAllUsers.filter(u => u.tipo_conta === 'professor');
  const active = profs.filter(u => !u.banned);
  const materias = new Set(profs.map(p => p.materia).filter(Boolean));
  const elTotal = document.getElementById('saProfCountTotal');
  const elActive = document.getElementById('saProfCountActive');
  const elMat = document.getElementById('saProfCountMaterias');
  if (elTotal) elTotal.textContent = String(profs.length);
  if (elActive) elActive.textContent = String(active.length);
  if (elMat) elMat.textContent = String(materias.size);

  if (!profs.length) {
    tbody.innerHTML = `<tr><td colspan="4"><div class="admin-empty-state">
      <div class="admin-empty-icon">👨‍🏫</div>
      <div class="admin-empty-title">Nenhum professor ainda</div>
      <div class="admin-empty-desc">Quando um professor se cadastrar em <strong>Criar conta</strong>, aparecerá aqui.</div>
    </div></td></tr>`;
    return;
  }
  tbody.innerHTML = profs.map(p => `<tr>
    <td><div class="admin-user-name">${esc(p.name||'—')}</div><div class="admin-user-email">${esc(p.email||'—')}</div></td>
    <td><span class="materia-pill">${esc(p.materia||'—')}</span></td>
    <td>${p.banned ? '<span class="status-pill status-pill--ban">⛔ Banido</span>' : '<span class="status-pill status-pill--ok">✅ Ativo</span>'}</td>
    <td class="admin-actions-cell">
      <button class="admin-action-btn ban" onclick="saBanirUser('${p.id}','${esc(p.name||p.email)}')">${p.banned?'Desbanir':'Banir'}</button>
      <button class="admin-action-btn del" onclick="saDeletarUser('${p.id}','${esc(p.name||p.email)}')">Excluir</button>
    </td>
  </tr>`).join('');
}

function renderSAUsuarios() {
  const tbody = document.getElementById('saUsersBody'); if(!tbody) return;
  const search = (document.getElementById('saUserSearch')?.value||'').toLowerCase();
  const tipo   = document.getElementById('saUserTypeFilter')?.value || 'all';

  let users = saAllUsers.filter(u => {
    const matchSearch = !search || (u.name||'').toLowerCase().includes(search) || (u.email||'').toLowerCase().includes(search);
    const matchTipo = tipo === 'all' || u.tipo_conta === tipo || (tipo === 'admin' && u.is_admin);
    return matchSearch && matchTipo;
  });

  if (!users.length) { tbody.innerHTML='<tr><td colspan="5" style="text-align:center;padding:32px;color:var(--text-muted)">Nenhum usuário</td></tr>'; return; }
  tbody.innerHTML = users.map(u => {
    const tipoBadge = u.tipo_conta === 'professor' ? '👨‍🏫 Prof' : u.tipo_conta === 'super_admin' ? '⚡ SuperAdmin' : u.is_admin ? '🛡️ Admin' : '👩‍🎓 Aluno';
    const extra = u.tipo_conta === 'aluno' ? `${u.serie||''} ${u.turma||''}` : u.materia||'';
    return `<tr>
      <td><div class="admin-user-name">${esc(u.name||'—')}</div><div class="admin-user-email">${esc(u.email||'—')}</div></td>
      <td style="font-size:12px">${tipoBadge}</td>
      <td style="font-size:12px;color:var(--text-dim)">${esc(extra)}</td>
      <td>${u.banned?'<span style="color:var(--red)">⛔</span>':'<span style="color:var(--green)">✅</span>'}</td>
      <td>
        <button class="admin-action-btn view" onclick="openRoleModal('${u.id}')">Tipo</button>
        <button class="admin-action-btn del" onclick="saDeletarUser('${u.id}','${esc(u.name||u.email)}')">Del</button>
      </td>
    </tr>`;
  }).join('');
}

function filterSAUsers() { renderSAUsuarios(); }

async function renderSATurmas() {
  const turmasEl  = document.getElementById('saTurmasList'); if(!turmasEl) return;
  const materEl   = document.getElementById('saMateriasList'); if(!materEl) return;

  const alunos = saAllUsers.filter(u => u.tipo_conta === 'aluno');
  const profs  = saAllUsers.filter(u => u.tipo_conta === 'professor');

  // Agrupa alunos por série+turma
  const turmaMap = {};
  alunos.forEach(a => {
    const key = `${a.serie||'?'} ${a.turma||'?'}`;
    turmaMap[key] = (turmaMap[key]||0)+1;
  });
  turmasEl.innerHTML = Object.entries(turmaMap).sort().map(([k,v]) =>
    `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px"><span style="color:var(--text)">${esc(k)}</span><span style="color:var(--cyan);font-family:'JetBrains Mono',monospace">${v} alunos</span></div>`
  ).join('') || '<div style="color:var(--text-muted);font-size:12px">Sem alunos cadastrados</div>';

  // Agrupa professores por matéria
  const materMap = {};
  profs.forEach(p => { const m = p.materia||'?'; materMap[m] = (materMap[m]||[]).concat(p.name||p.email); });
  materEl.innerHTML = Object.entries(materMap).sort().map(([m,nomes]) =>
    `<div style="margin-bottom:12px"><div style="font-weight:700;color:var(--text);font-size:13px;margin-bottom:4px">${esc(m)}</div>${nomes.map(n=>`<div style="font-size:12px;color:var(--text-muted);padding-left:10px">• ${esc(n)}</div>`).join('')}</div>`
  ).join('') || '<div style="color:var(--text-muted);font-size:12px">Sem professores cadastrados</div>';
}

async function saBanirUser(uid, name) {
  const u = saAllUsers.find(x=>x.id===uid);
  const ban = !u?.banned;
  if (!confirm(`${ban?'Banir':'Desbanir'} "${name}"?`)) return;
  await sb.from('users').update({ banned: ban }).eq('id', uid);
  showToast(`${ban?'⛔':'✅'} ${name} ${ban?'banido':'desbanido'}`, 'success'); setTimeout(hideToast,3000);
  loadSuperAdminData();
}

async function saDeletarUser(uid, name) {
  if (!confirm(`⚠️ APAGAR a conta de "${name}"? Irreversível.`)) return;
  await sb.from('users').delete().eq('id', uid);
  showToast('🗑️ Conta removida', 'success'); setTimeout(hideToast,3000);
  loadSuperAdminData();
}

let roleModalUserId = null;

function findUserById(uid) {
  return saAllUsers.find(x => x.id === uid)
    || adminAllUsers.find(x => x.id === uid || x.uid === uid)
    || null;
}

function openRoleModal(uid) {
  const u = findUserById(uid);
  if (!u) { showToast('❌ Usuário não encontrado', 'error'); setTimeout(hideToast, 2500); return; }
  if ((u.email || '').toLowerCase() === SUPREME_ADMIN_EMAIL) {
    showToast('❌ Não é possível alterar o administrador supremo', 'error');
    setTimeout(hideToast, 3000);
    return;
  }

  roleModalUserId = uid;
  const label = document.getElementById('roleModalUserLabel');
  const tipoSel = document.getElementById('roleModalTipo');
  const errEl = document.getElementById('roleModalError');
  if (label) label.textContent = `${u.name || '—'} · ${u.email || ''}`;
  if (tipoSel) tipoSel.value = u.tipo_conta || 'aluno';
  if (document.getElementById('roleModalMateria') && u.materia) {
    document.getElementById('roleModalMateria').value = u.materia;
  }
  if (document.getElementById('roleModalSerie') && u.serie) {
    document.getElementById('roleModalSerie').value = u.serie;
  }
  if (document.getElementById('roleModalTurma') && u.turma) {
    document.getElementById('roleModalTurma').value = u.turma;
  }
  if (errEl) { errEl.classList.add('hidden'); errEl.textContent = ''; }

  const isSupreme = (currentUser?.email || '').toLowerCase() === SUPREME_ADMIN_EMAIL;
  tipoSel?.querySelectorAll('option').forEach(opt => {
    if (opt.value === 'admin' || opt.value === 'super_admin') {
      opt.disabled = !isSupreme;
    }
  });

  toggleRoleModalFields();
  document.getElementById('roleModal')?.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeRoleModal() {
  roleModalUserId = null;
  document.getElementById('roleModal')?.classList.add('hidden');
  document.body.style.overflow = '';
}

function toggleRoleModalFields() {
  const tipo = document.getElementById('roleModalTipo')?.value || 'aluno';
  document.getElementById('roleModalAlunoFields')?.classList.toggle('hidden', tipo !== 'aluno');
  document.getElementById('roleModalProfFields')?.classList.toggle('hidden', tipo !== 'professor');
}

async function saveRoleModal() {
  if (!roleModalUserId) return;
  const tipo = (document.getElementById('roleModalTipo')?.value || 'aluno').trim();
  const materia = document.getElementById('roleModalMateria')?.value || '';
  const serie = document.getElementById('roleModalSerie')?.value || '';
  const turma = document.getElementById('roleModalTurma')?.value || '';
  const errEl = document.getElementById('roleModalError');
  const btn = document.getElementById('roleModalSaveBtn');

  if (tipo === 'professor' && !materia) {
    if (errEl) { errEl.textContent = 'Selecione a matéria do professor.'; errEl.classList.remove('hidden'); }
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }
  if (errEl) errEl.classList.add('hidden');

  const { data, error } = await sb.rpc('admin_set_user_tipo', {
    p_user_id: roleModalUserId,
    p_tipo: tipo,
    p_materia: tipo === 'professor' ? materia : null,
    p_serie: tipo === 'aluno' ? serie : null,
    p_turma: tipo === 'aluno' ? turma : null
  });

  if (btn) { btn.disabled = false; btn.textContent = 'Salvar alteração'; }

  if (error) {
    const msg = error.message.includes('admin_set_user_tipo')
      ? 'Função admin_set_user_tipo não encontrada. Execute o SQL em supabase/migrations/20250603140000_fix_admin_set_user_tipo.sql'
      : error.message;
    if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); }
    showToast('❌ ' + msg, 'error');
    setTimeout(hideToast, 4000);
    return;
  }

  const u = findUserById(roleModalUserId);
  if (u) {
    u.tipo_conta = tipo;
    u.is_admin = tipo === 'admin' || tipo === 'super_admin';
    if (tipo === 'professor') u.materia = materia;
    if (tipo === 'aluno') { u.serie = serie; u.turma = turma; u.materia = ''; }
  }

  await DB.logActivity(currentUser.id, 'admin', `Tipo alterado para ${tipo}: ${u?.email || roleModalUserId}`);
  closeRoleModal();
  closeAdminUserModal();
  showToast('✅ Tipo atualizado com sucesso', 'success');
  setTimeout(hideToast, 2500);
  if (typeof loadSuperAdminData === 'function') loadSuperAdminData();
  if (typeof loadAdminData === 'function') loadAdminData();
}

function saEditarTipo(uid) {
  openRoleModal(uid);
}

/* ═══════════════════════════════════════
   MANUTENÇÃO DO BANCO
═══════════════════════════════════════ */
async function maintClean(table, label) {
  if (!confirm(`⚠️ Apagar TODO o ${label}?\n\nEsta ação é IRREVERSÍVEL.`)) return;
  const logEl = document.getElementById('maintLog');
  if (logEl) logEl.textContent = `⏳ Limpando ${label}...`;
  try {
    const { error, count } = await sb.from(table).delete().gte('created_at', '1970-01-01');
    if (error) throw error;
    showToast(`🧹 ${label} limpo!`, 'success'); setTimeout(hideToast, 3000);
    if (logEl) logEl.textContent = `✅ ${label} limpo com sucesso — ${new Date().toLocaleString('pt-BR')}`;
  } catch(e) {
    showToast('❌ Erro: '+e.message, 'error'); setTimeout(hideToast,3000);
    if (logEl) logEl.textContent = `❌ Erro: ${e.message}`;
  }
}

async function maintCleanOld(table, days, label) {
  if (!confirm(`⚠️ Apagar ${label} com mais de ${days} dias?\n\nEsta ação é IRREVERSÍVEL.`)) return;
  const logEl = document.getElementById('maintLog');
  const since = new Date(Date.now() - days*86400000).toISOString();
  if (logEl) logEl.textContent = `⏳ Limpando ${label}...`;
  try {
    const { error } = await sb.from(table).delete().lt('created_at', since);
    if (error) throw error;
    showToast(`🧹 ${label} limpos!`, 'success'); setTimeout(hideToast, 3000);
    if (logEl) logEl.textContent = `✅ ${label} anteriores a ${new Date(since).toLocaleDateString('pt-BR')} removidos — ${new Date().toLocaleString('pt-BR')}`;
  } catch(e) {
    showToast('❌ Erro: '+e.message, 'error'); setTimeout(hideToast,3000);
    if (logEl) logEl.textContent = `❌ Erro: ${e.message}`;
  }
}

/* SQL de segurança e RLS: supabase/migrations/20250603120000_security_rls.sql */
