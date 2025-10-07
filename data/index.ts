// 테마 토글: 사용자 선택을 로컬스토리지에 저장
(() => {
  const root: HTMLElement = document.documentElement;
  const key = 'ml-tools-theme';
  const btn = document.getElementById('themeToggle') as HTMLButtonElement | null;

  if (!btn) {
    console.error('themeToggle 버튼을 찾을 수 없습니다.');
    return;
  }

  type Theme = 'light' | 'dark';

  function applyTheme(theme: Theme): void {
    if (theme === 'light') {
      root.setAttribute('data-theme', 'light');
    } else {
      root.removeAttribute('data-theme');
    }
    btn.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
    btn.textContent = theme === 'light' ? '🌤 라이트' : '🌙 다크';
  }

  // 초기: 로컬 스토리지 또는 미디어 쿼리 기반
  const saved: string | null = localStorage.getItem(key);
  if (saved === 'light' || saved === 'dark') {
    applyTheme(saved);
  } else {
    const prefersLight: boolean =
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: light)').matches;
    applyTheme(prefersLight ? 'light' : 'dark');
  }

  btn.addEventListener('click', () => {
    const current: Theme =
      root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const next: Theme = current === 'light' ? 'dark' : 'light';
    applyTheme(next);
    localStorage.setItem(key, next);
  });
})();
