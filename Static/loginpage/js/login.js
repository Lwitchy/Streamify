window.API_BASE_URL = window.API_BASE_URL || '';

const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const loginWrapper = document.getElementById('loginWrapper');
const registerWrapper = document.getElementById('registerWrapper');
const showRegisterBtn = document.getElementById('showRegister');
const showLoginBtn = document.getElementById('showLogin');
const loadingSpinner = document.getElementById('loadingSpinner');

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
        window.location.href = '/home';
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
    const password = document.getElementById('regPassword').value;
    const confirm = document.getElementById('regConfirmPassword').value;
    const errorText = document.getElementById('regFailedText');

    if (password !== confirm) {
      errorText.innerText = "check ur pass buddy";
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
        // success
        loadingSpinner.style.display = 'none';
        toggleForms(false);
        const failedText = document.getElementById('failedText');
        if (failedText) {
          failedText.style.display = 'block';
          failedText.style.color = '#4CAF50';
          failedText.innerHTML = 'Account created! Please sign in.';
        }
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
