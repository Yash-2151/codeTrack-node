const API_BASE = (() => {
  const { protocol, hostname, port } = window.location;
  const isLocalStaticPreview =
    (hostname === "127.0.0.1" || hostname === "localhost") &&
    port &&
    port !== "3000";

  // When the HTML is opened from a separate static preview port, still target
  // the local API server instead of the preview origin.
  if (isLocalStaticPreview) {
    return `${protocol}//${hostname}:3000/api`;
  }

  return "/api";
})();
const TEACHER_ROLE = "pro";
const STUDENT_ROLE = "user";
const DEFAULT_REDIRECTS = {
  user: "index.html",
  pro: "index.html"
};
const ROLE_ALLOWED_PAGES = {
  user: new Set([
    "index.html",
    "submissions.html",
    "progress.html",
    "about.html",
    "contact.html",
    "faq.html",
    "login.html",
    "signup.html"
  ]),
  pro: new Set([
    "index.html",
    "exercises.html",
    "submissions.html",
    "progress.html",
    "about.html",
    "contact.html",
    "faq.html",
    "login.html",
    "signup.html"
  ])
};
let activeCaptchaAnswer = null;
const GMAIL_EMAIL_PATTERN = /^[^@\s]+@gmail\.com$/i;

function normalizeRole(role) {
  if (role === "teacher") return TEACHER_ROLE;
  if (role === "student") return STUDENT_ROLE;
  return role || "";
}

const toast = (message, isError = false) => {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = isError ? "toast error" : "toast";
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => el.classList.remove("show"), 3200);
};

async function postJSON(path, payload) {
  const email = (localStorage.getItem("codetrack_user_email") || "").trim().toLowerCase();
  const role = currentRole();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // The backend uses these headers to recover the active demo session
      // because there is no token/session middleware in this project.
      ...(email ? { "X-CodeTrack-Email": email } : {}),
      ...(role ? { "X-CodeTrack-Role": role } : {})
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    try {
      const data = await res.clone().json();
      throw new Error(data.error || "Request failed");
    } catch (error) {
      if (error instanceof Error && error.message !== "Unexpected end of JSON input") {
        throw error;
      }
      const text = await res.text();
      throw new Error(text || "Request failed");
    }
  }
  return res.json();
}

function currentRole() {
  return normalizeRole(localStorage.getItem("codetrack_user_role") || "");
}

function normalizePageName(page) {
  return String(page || "")
    .split("?")[0]
    .split("#")[0]
    .split("/")
    .pop()
    .trim() || "index.html";
}

function canRoleAccessPage(role, page) {
  const normalizedRole = normalizeRole(role);
  const normalizedPage = normalizePageName(page);
  const allowedPages = ROLE_ALLOWED_PAGES[normalizedRole];
  if (!allowedPages) return true;
  return allowedPages.has(normalizedPage);
}

function resolvePostAuthDestination(role, requestedPage = "") {
  const fallback = DEFAULT_REDIRECTS[normalizeRole(role)] || "index.html";
  if (!requestedPage) return fallback;
  return canRoleAccessPage(role, requestedPage) ? normalizePageName(requestedPage) : fallback;
}

function isValidGmailEmail(email) {
  return GMAIL_EMAIL_PATTERN.test(String(email || "").trim());
}

function isValidPassword(password) {
  return String(password || "").length >= 6;
}

function currentUserName() {
  return localStorage.getItem("codetrack_user_name") || "";
}

function isLoggedIn() {
  return Boolean(localStorage.getItem("codetrack_user_email"));
}

function logout() {
  localStorage.removeItem("codetrack_user_email");
  localStorage.removeItem("codetrack_user_role");
  localStorage.removeItem("codetrack_user_name");
  window.location.href = "login.html";
}

function showBySelector(selector, visible) {
  document.querySelectorAll(selector).forEach((el) => {
    el.classList.toggle("hidden", !visible);
  });
}

function updateRoleNav() {
  const role = currentRole();
  const loggedIn = isLoggedIn();
  const roleLabel = role === TEACHER_ROLE ? "Teacher" : "Student";
  const loginMenus = document.querySelectorAll(".auth-menu");
  const logoutButtons = document.querySelectorAll("[data-logout]");
  const roleBadges = document.querySelectorAll("[data-role-badge]");
  const guestOnly = document.querySelectorAll("[data-guest-only]");
  const loggedInOnly = document.querySelectorAll("[data-logged-in-only]");
  const teacherOnly = document.querySelectorAll("[data-role-only='pro']");
  const studentOnly = document.querySelectorAll("[data-role-only='user']");
  const studentViewHiddenForTeacher = document.querySelectorAll("[data-hide-for-role='pro']");
  const teacherViewHiddenForStudent = document.querySelectorAll("[data-hide-for-role='user']");

  loginMenus.forEach((el) => el.classList.toggle("hidden", loggedIn));
  guestOnly.forEach((el) => el.classList.toggle("hidden", loggedIn));
  loggedInOnly.forEach((el) => el.classList.toggle("hidden", !loggedIn));
  logoutButtons.forEach((btn) => {
    btn.classList.toggle("hidden", !loggedIn);
    btn.textContent = loggedIn ? `Logout${currentUserName() ? ` · ${currentUserName()}` : ""}` : "Logout";
  });
  roleBadges.forEach((el) => {
    el.classList.toggle("hidden", !loggedIn);
    el.textContent = loggedIn ? `${roleLabel} workspace` : "";
  });

  teacherOnly.forEach((el) => el.classList.toggle("hidden", role !== TEACHER_ROLE));
  studentOnly.forEach((el) => el.classList.toggle("hidden", role !== STUDENT_ROLE));
  studentViewHiddenForTeacher.forEach((el) => el.classList.toggle("hidden", role === TEACHER_ROLE));
  teacherViewHiddenForStudent.forEach((el) => el.classList.toggle("hidden", role === STUDENT_ROLE));
}

function enforcePageAccess() {
  const requiresAuth = document.body.dataset.requiresAuth === "true";
  const requiredRole = normalizeRole(document.body.dataset.requiresRole);
  if (!requiresAuth && !requiredRole) return;

  if (!isLoggedIn()) {
    window.location.href = `login.html?next=${encodeURIComponent(window.location.pathname.split("/").pop() || "index.html")}`;
    return;
  }

  if (!requiredRole) return;

  if (currentRole() !== requiredRole) {
    window.location.href = resolvePostAuthDestination(currentRole());
  }
}

function wireContactForm() {
  const form = document.getElementById("contactForm");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = form.querySelector("input[name='name']")?.value;
    const email = form.querySelector("input[name='email']")?.value;
    const reason = form.querySelector("select[name='reason']")?.value;
    const message = form.querySelector("textarea[name='message']")?.value;
    try {
      await postJSON("/contact", { name, email, reason, message });
      toast("Message sent. We’ll reply shortly.");
      form.reset();
    } catch (err) {
      toast("Could not send message.", true);
    }
  });
}

function buildProfilePayload(form, role) {
  const fullName = form.querySelector("input[type='text']")?.value || "";
  return {
    fullName: fullName.trim()
  };
}

function setActiveRole(role) {
  const normalizedRole = normalizeRole(role);
  const buttons = document.querySelectorAll(".segmented-btn");
  if (!buttons.length) return;

  buttons.forEach((btn) => {
    const isActive = btn.dataset.role === normalizedRole;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  updateRoleFootnote(normalizedRole);
}

function wireAuthForm(form) {
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const role = document.querySelector(".segmented-btn.active")?.dataset.role || "user";
    const email = (form.querySelector("input[type='email']")?.value || "").trim().toLowerCase();
    const password = form.querySelector("input[type='password']")?.value || "";
    const mode = form.id === "signupForm" ? "signup" : "login";

    if (!isValidGmailEmail(email)) {
      toast("Email must be a valid Gmail address ending with @gmail.com.", true);
      return;
    }

    if (!isValidPassword(password)) {
      toast("Password must be at least 6 characters long.", true);
      return;
    }

    if (mode === "signup") {
      const confirmPassword = document.getElementById("signupConfirmPassword")?.value || "";
      const captchaAnswer = (document.getElementById("captchaAnswer")?.value || "").trim();
      const passwordMessage = document.getElementById("passwordMatchMessage");
      const captchaMessage = document.getElementById("captchaMessage");

      if (password !== confirmPassword) {
        if (passwordMessage) {
          passwordMessage.textContent = "Password and confirm password must match.";
          passwordMessage.className = "form-helper error";
          passwordMessage.classList.remove("hidden");
        }
        toast("Password and confirm password must match.", true);
        return;
      }

      if (passwordMessage) {
        passwordMessage.textContent = "Passwords match.";
        passwordMessage.className = "form-helper success";
        passwordMessage.classList.remove("hidden");
      }

      if (!captchaAnswer || captchaAnswer !== activeCaptchaAnswer) {
        if (captchaMessage) {
          captchaMessage.textContent = "Captcha verification failed. Please try again.";
          captchaMessage.className = "form-helper error";
          captchaMessage.classList.remove("hidden");
        }
        setupCaptcha();
        toast("Captcha verification failed.", true);
        return;
      }

      if (captchaMessage) {
        captchaMessage.textContent = "Captcha verified.";
        captchaMessage.className = "form-helper success";
        captchaMessage.classList.remove("hidden");
      }
    }

    try 
    {
      const response = await postJSON("/auth", 
        {
        mode,
        email,
        password,
        role,
        profile: buildProfilePayload(form, role)
      });

      const normalizedRole = normalizeRole(response.user?.role || role);

      localStorage.setItem("codetrack_user_email", response.user?.email || email || "");
      localStorage.setItem("codetrack_user_role", normalizedRole);
      localStorage.setItem("codetrack_user_name", response.user?.fullName || "");

      toast(mode === "signup" ? "Account created successfully." : "Signed in successfully.");
      const next = new URLSearchParams(window.location.search).get("next");
      const destination = resolvePostAuthDestination(normalizedRole, next || "");
      setTimeout(() => (window.location.href = destination), 600);
    } catch (err) {
      const message = err?.message || "Authentication failed.";
      if (message.includes("registered as a teacher")) {
        setActiveRole("pro");
      } else if (message.includes("registered as a student")) {
        setActiveRole("user");
      }
      toast(message, true);
    }
  });
}

function setupCaptcha() {
  const challengeEl = document.getElementById("captchaChallenge");
  const answerInput = document.getElementById("captchaAnswer");
  const messageEl = document.getElementById("captchaMessage");
  if (!challengeEl || !answerInput) return;

  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const chars = letters + digits;
  const captchaChars = [
    letters[Math.floor(Math.random() * letters.length)],
    digits[Math.floor(Math.random() * digits.length)]
  ];

  // Guarantee at least one letter and one digit so the challenge stays readable
  // without degenerating into a single character class.
  while (captchaChars.length < 6) {
    captchaChars.push(chars[Math.floor(Math.random() * chars.length)]);
  }

  for (let i = captchaChars.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [captchaChars[i], captchaChars[j]] = [captchaChars[j], captchaChars[i]];
  }

  activeCaptchaAnswer = captchaChars.join("");
  challengeEl.textContent = activeCaptchaAnswer;
  answerInput.value = "";
  if (messageEl) {
    messageEl.textContent = "";
    messageEl.className = "form-helper hidden";
  }
}

function wireSignupValidation() {
  const passwordInput = document.getElementById("signupPassword");
  const confirmPasswordInput = document.getElementById("signupConfirmPassword");
  const passwordMessage = document.getElementById("passwordMatchMessage");
  const refreshCaptcha = document.getElementById("refreshCaptcha");
  if (!passwordInput || !confirmPasswordInput) return;

  const checkPasswords = () => {
    if (!passwordMessage) return;
    if (!confirmPasswordInput.value) {
      passwordMessage.textContent = "";
      passwordMessage.className = "form-helper hidden";
      return;
    }

    if (!isValidPassword(passwordInput.value) || !isValidPassword(confirmPasswordInput.value)) {
      passwordMessage.textContent = "Password must be at least 6 characters long.";
      passwordMessage.className = "form-helper error";
      passwordMessage.classList.remove("hidden");
      return;
    }

    if (passwordInput.value === confirmPasswordInput.value) {
      passwordMessage.textContent = "Passwords match.";
      passwordMessage.className = "form-helper success";
      passwordMessage.classList.remove("hidden");
    } else {
      passwordMessage.textContent = "Password and confirm password do not match.";
      passwordMessage.className = "form-helper error";
      passwordMessage.classList.remove("hidden");
    }
  };

  passwordInput.addEventListener("input", checkPasswords);
  confirmPasswordInput.addEventListener("input", checkPasswords);
  refreshCaptcha?.addEventListener("click", setupCaptcha);
  setupCaptcha();
}

function updateRoleFootnote(role) {
  const footnote = document.querySelector(".auth-footnote");
  if (footnote) {
    footnote.innerHTML =
      role === "pro"
        ? "<p class='muted'>Teachers can publish exercises, review attempts, and leave detailed feedback for each submission.</p>"
        : "<p class='muted'>Students can submit multiple attempts, track score changes, and learn from instructor comments.</p>";
  }
}

function wireRoleToggle() {
  const buttons = document.querySelectorAll(".segmented-btn");
  if (!buttons.length) return;
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      setActiveRole(btn.dataset.role);
    });
  });
}

function wireLogoutButtons() {
  document.querySelectorAll("[data-logout]").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      logout();
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  enforcePageAccess();

  const params = new URLSearchParams(window.location.search);
  const roleParam = params.get("role");
  const normalizedRole =
    roleParam === "teacher" ? "pro" : roleParam === "student" ? "user" : roleParam;

  if (normalizedRole) {
    setActiveRole(normalizedRole);
  }

  wireContactForm();
  wireAuthForm(document.getElementById("authForm"));
  wireAuthForm(document.getElementById("signupForm"));
  wireRoleToggle();
  wireSignupValidation();
  wireLogoutButtons();
  updateRoleNav();
});
