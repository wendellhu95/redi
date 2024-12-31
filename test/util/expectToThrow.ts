import { expect, vi } from 'vitest'

/**
 * Helps prevent error logs blowing up as a result of expecting an error to be thrown,
 * when using a library (such as enzyme)
 *
 * @param func Function that you would normally pass to `expect(func).toThrow()`
 */
export function expectToThrow(func: () => unknown, error?: string): void {
  // Even though the error is caught, it still gets printed to the console
  // so we mock that out to avoid the wall of red text.
  const spy = vi.spyOn(console, 'error')
  spy.mockImplementation(() => {
    // empty
  })

  expect(func).toThrow(error)

  spy.mockRestore()
}
