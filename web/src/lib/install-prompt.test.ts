import { act, renderHook } from '@testing-library/react';
import { installState, listenForInstallPrompt, useInstallPrompt } from './install-prompt';

it('garde l’invitation du navigateur, propose le bouton puis passe à « installée » une fois acceptée', async () => {
  const win = new EventTarget() as unknown as Window;
  listenForInstallPrompt(win);
  const { result } = renderHook(() => useInstallPrompt());
  expect(result.current.state).toBe('manual');

  const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt: vi.fn(async () => undefined),
    userChoice: Promise.resolve({ outcome: 'accepted' as const }),
  });
  act(() => {
    win.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(true);
  expect(result.current.state).toBe('prompt');

  await act(() => result.current.install());
  expect(event.prompt).toHaveBeenCalled();
  expect(result.current.state).toBe('installed');
});

it('reconnaît un iPhone, où seul Safari › Partager installe l’application', () => {
  const ua = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
  expect(installState()).toBe('ios');
  ua.mockRestore();
});
