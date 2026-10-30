import type {NestwiseEnvironment} from './nestwise-delivery.mjs';
export function nestwiseLabels(request:Request,sql:{query:(text:string,params:unknown[])=>Promise<unknown>},env:NestwiseEnvironment,now?:number):Promise<Response>;
