export function nestwiseAdmin(request: Request, sql: {query:(text:string,params:unknown[])=>Promise<unknown>}, user:{id:string;role:string}):Promise<{status:number;body:unknown}>;
