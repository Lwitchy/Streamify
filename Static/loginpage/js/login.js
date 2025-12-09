const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const loginWrapper = document.getElementById('loginWrapper');
const registerWrapper = document.getElementById('registerWrapper');
const showRegisterBtn = document.getElementById('showRegister');
const showLoginBtn = document.getElementById('showLogin');
const loadingSpinner = document.getElementById('loadingSpinner');

// Toggle between Login and Register with Blurry Fade
function toggleForms(showRegister) {
  const current = showRegister ? loginWrapper : registerWrapper;
  const next = showRegister ? registerWrapper : loginWrapper;

  // 1. Fade out current
  current.classList.add('hidden');
  current.classList.remove('active');

  // 2. Wait for transition, then show next
  setTimeout(() => {
    // Ensure display logic if needed handled by CSS, but we use absolute positioning so they overlap
    // We rely on opacity/z-index in CSS

    next.classList.remove('hidden');
    next.classList.add('active');
  }, 500); // Matches CSS transition time
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

// Validation
function validateRegister() {
  const password = document.getElementById('regPassword').value;
  const confirm = document.getElementById('regConfirmPassword').value;
  const errorText = document.getElementById('regFailedText');

  if (password !== confirm) {
    errorText.innerText = "check ur pass buddy";
    errorText.style.display = "block";
    return false;
  }

  // Show spinner on submit
  registerWrapper.classList.add('hidden');
  loadingSpinner.style.display = 'block';
  return true;
}

function hashPassword() {
  // Show spinner on submit
  loginWrapper.classList.add('hidden');
  loadingSpinner.style.display = 'block';
  return true;
}


window.addEventListener('load', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const intro = document.getElementById('intro');
  const failedText = document.getElementById('failedText');
  const regFailedText = document.getElementById('regFailedText');

  // Handle Intro Logic
  if (intro) {
    // Check for return flags
    if (urlParams.get('failed') === 'true' || urlParams.get('blocked') === 'true' || urlParams.get('registered') === 'true' || urlParams.get('reg_failed') === 'true') {
      intro.style.display = 'none';
      document.body.classList.add('loaded'); // Skip intro

      if (urlParams.get('failed') === 'true') {
        const failedCount = urlParams.get('count');
        if (failedText) {
          failedText.style.display = 'block';
          if (failedCount > 3) failedText.innerHTML = "No you didn't!";
          else if (failedCount) failedText.innerHTML = `Failed to login ${failedCount} times`;
          else failedText.innerHTML = `Invalid credentials`;
        }
      }

      if (urlParams.get('blocked') === 'true') {
        if (failedText) {
          failedText.style.display = 'block';
          failedText.innerHTML = 'You have been blocked from logging in';
        }
      }

      // Registration Feedback
      if (urlParams.get('registered') === 'true') {
        // Show login form with success message
        if (failedText) {
          failedText.style.display = 'block';
          failedText.style.color = '#4CAF50'; // Green
          failedText.innerHTML = 'Account created! Please sign in.';
        }
      }

      if (urlParams.get('reg_failed') === 'true') {
        // We should probably switch to register form here, but for simplicity let's stay on login or user clicks switch
        // Ideally we show the register form.
        toggleForms(true); // Switch to register
        if (regFailedText) {
          regFailedText.style.display = 'block';
          regFailedText.innerHTML = 'Username or Email already exists.';
        }
      }

    } else {
      // Play Intro
      intro.style.display = 'block';
      failedText.style.display = 'none';
      setTimeout(() => {
        document.body.classList.add('loaded');
      }, 3500);
    }
  }
});

