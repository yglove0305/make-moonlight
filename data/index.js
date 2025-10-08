 (function(){
      const root = document.documentElement;
      const key = 'ml-tools-theme';
      const btn = document.getElementById('themeToggle');

      function applyTheme(theme){
        if(theme === 'light') root.setAttribute('data-theme','light');
        else root.removeAttribute('data-theme');
        btn.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
        btn.textContent = theme === 'light' ? '🌤 라이트' : '🌙 다크';
      }

      // 초기: 로컬 스토리지 또는 미디어 쿼리 기반
      const saved = localStorage.getItem(key);
      if(saved) applyTheme(saved);
      else {
        const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
        applyTheme(prefersLight ? 'light' : 'dark');
      }

      btn.addEventListener('click', function(){
        const current = root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
        const next = current === 'light' ? 'dark' : 'light';
        applyTheme(next);
        localStorage.setItem(key, next);
      });
    })();
