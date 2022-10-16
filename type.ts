export function defineApi(func: (req: Request, url: URL) => Promise<Response> | Response) {
    return func
}