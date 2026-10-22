import { useEffect, useState } from 'react'
import { Package } from 'lucide-react'
import { configuredApiUrl } from './api'
export function InventoryPhoto({token,id,photoKey,name}:{token:string;id:string;photoKey?:string|null;name:string}) {
  const [url,setUrl]=useState('')
  useEffect(()=>{
    if(!photoKey)return
    const controller=new AbortController();let objectUrl=''
    void fetch(`${configuredApiUrl}/api/inventory/parts/${id}/photo`,{headers:{Authorization:`Bearer ${token}`},signal:controller.signal}).then(async response=>{
      if(!response.ok)throw new Error('Photo unavailable')
      const blob=await response.blob();if(controller.signal.aborted)return
      objectUrl=URL.createObjectURL(blob);setUrl(objectUrl)
    }).catch(()=>{})
    return()=>{controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl)}
  },[token,id,photoKey])
  return url?<img className="inventory-photo" src={url} alt={name}/>:<Package aria-hidden="true" size={32}/>
}
