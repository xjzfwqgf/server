/**
 * Express 4 不会自动捕获 async 处理器里的 reject。
 * 所有 async 路由都用 ah() 包一层，异常统一进全局错误处理。
 */
export function ah(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

export const asyncHandler = ah
export default ah
