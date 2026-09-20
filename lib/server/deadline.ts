import "server-only";
import { SafeError } from "./config";
export async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  message = "This operation took too long. Please try again.",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SafeError(message, 504)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
