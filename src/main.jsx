import React from 'react'
import ReactDOM from 'react-dom/client'
import { message } from 'antd'
import App from './App'
import { cutOffMessage } from './lib/apiFetch'
import './App.css'

// An answer cut off on the way (#147) is thrown where it is read, and most
// callers do not catch: said here, once, for all of them.
window.addEventListener('unhandledrejection', event => {
  if (event.reason?.name !== 'AnswerCutOff') return
  event.preventDefault()
  message.error({ content: cutOffMessage(event.reason), duration: 0, key: 'answer-cut-off' })
})

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
