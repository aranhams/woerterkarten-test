import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import AudienceView from './AudienceView.jsx'
import { isAudienceWindow } from './lib/present'
import './styles/app.css'

const Root = isAudienceWindow() ? AudienceView : App
ReactDOM.createRoot(document.getElementById('root')).render(<React.StrictMode><Root /></React.StrictMode>)
