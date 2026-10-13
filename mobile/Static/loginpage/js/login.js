window.API_BASE_URL = window.API_BASE_URL || localStorage.getItem('streamify_server_url') || '';

const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const loginWrapper = document.getElementById('loginWrapper');
const registerWrapper = document.getElementById('registerWrapper');
const showRegisterBtn = document.getElementById('showRegister');
const showLoginBtn = document.getElementById('showLogin');
const loadingSpinner = document.getElementById('loadingSpinner');

fetch((window.API_BASE_URL || '') + '/api/config/public')
  .then(res => res.json())
  .then(config => {
    if (config.is_fresh_install || config.user_count === 0) {
      // Direct fresh install straight to Registration page to create the Owner account
      loginWrapper.classList.add('hidden');
      loginWrapper.classList.remove('active');
      registerWrapper.classList.remove('hidden');
      registerWrapper.classList.add('active');
      const subHeader = document.querySelector('#registerWrapper .wrapper-header p');
      if (subHeader) {
        subHeader.innerHTML = 'Create the <strong style="color:var(--accent);">Owner account</strong> to set up your server.';
      }
    } else if (config.allow_registration !== true && showRegisterBtn) {
      const registrationLink = showRegisterBtn.closest('.toggle-link');
      if (registrationLink) registrationLink.style.display = 'none';
    }
  })
  .catch(() => {});

function toggleForms(showRegister) {
  const current = showRegister ? loginWrapper : registerWrapper;
  const next = showRegister ? registerWrapper : loginWrapper;

  current.classList.add('hidden');
  current.classList.remove('active');

  setTimeout(() => {
    next.classList.remove('hidden');
    next.classList.add('active');
  }, 500); 
}

if (showRegisterBtn) {
  showRegisterBtn.addEventListener('click', (e) => {
    e.preventDefault();
    toggleForms(true);
  });
}

if (showLoginBtn) {
  showLoginBtn.addEventListener('click', (e) => {
    e.preventDefault();
    toggleForms(false);
  });
}

// FETCH Logic replacing standard form submissions
if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    loginWrapper.classList.add('hidden');
    loadingSpinner.style.display = 'block';
    
    const formData = new URLSearchParams(new FormData(loginForm));
    
    try {
      const res = await fetch(window.API_BASE_URL + '/loginrequest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData,
        credentials: 'include'
      });
      const data = await res.json();
      
      if (res.ok && data.success) {
        if (data.sessionId) {
          localStorage.setItem('streamify_session_id', data.sessionId);
        }
        const isCapacitor = window.location.protocol.startsWith('capacitor') || (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
        window.location.href = isCapacitor ? '/Static/home/home.html' : '/home';
      } else {
        loginWrapper.classList.remove('hidden');
        loadingSpinner.style.display = 'none';
        const failedText = document.getElementById('failedText');
        failedText.style.display = 'block';
        failedText.innerText = data.error || 'Invalid credentials';
      }
    } catch (err) {
        loginWrapper.classList.remove('hidden');
        loadingSpinner.style.display = 'none';
        const failedText = document.getElementById('failedText');
        failedText.style.display = 'block';
        failedText.innerText = 'Network error';
    }
  });
}

if (registerForm) {
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('regUsername').value;
    const password = document.getElementById('regPassword').value;
    const confirm = document.getElementById('regConfirmPassword').value;
    const errorText = document.getElementById('regFailedText');

    if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) {
      errorText.innerText = 'Username must be 3-32 characters using only letters, numbers, underscores, or hyphens.';
      errorText.style.display = 'block';
      return;
    }

    if (password !== confirm) {
      errorText.innerText = 'Passwords do not match.';
      errorText.style.display = "block";
      return;
    }

    registerWrapper.classList.add('hidden');
    loadingSpinner.style.display = 'block';
    
    const formData = new URLSearchParams(new FormData(registerForm));
    
    try {
      const res = await fetch(window.API_BASE_URL + '/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData,
        credentials: 'include'
      });
      const data = await res.json();
      
      if (res.ok && data.success) {
        if (data.sessionId) {
          localStorage.setItem('streamify_session_id', data.sessionId);
        }
        const isCapacitor = window.location.protocol.startsWith('capacitor') || (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
        window.location.href = isCapacitor ? '/Static/home/home.html' : '/home';
      } else {
        registerWrapper.classList.remove('hidden');
        loadingSpinner.style.display = 'none';
        errorText.style.display = 'block';
        errorText.innerText = data.error || 'Registration failed';
      }
    } catch (err) {
        registerWrapper.classList.remove('hidden');
        loadingSpinner.style.display = 'none';
        errorText.style.display = 'block';
        errorText.innerText = 'Network error';
    }
  });
}

window.addEventListener('load', () => {
  const intro = document.getElementById('intro');
  if (intro) {
      intro.style.display = 'block';
      setTimeout(() => {
        document.body.classList.add('loaded');
      }, 3500);
  }
});
