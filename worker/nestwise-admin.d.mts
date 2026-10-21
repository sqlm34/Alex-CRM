import type {NestwiseEnvironment} from './nestwise-delivery.mjs';
export function nestwiseAdmin(request: Request, sql: {query:(text:string,params:unknown[])=>Promise<unknown>}, user:{id:string;role:string}, env?:NestwiseEnvironment):Promise<{status:number;body:unknown}>;
