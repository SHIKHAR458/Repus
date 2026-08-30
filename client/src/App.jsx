import React from 'react'
import {BrowserRouter , Routes , Route} from 'react-router-dom'
import Home from './pages/Home.jsx'
import { useEffect } from 'react'
import {socket} from './socket.js'
import Room from './pages/Room.jsx'
import JoinRoom from './pages/JoinRoom.jsx';

const App = () => {
  useEffect(() => { 
    socket.connect();
    return () => {
      socket.disconnect();
    };
  }, []);

  return (
    <BrowserRouter>
    <Routes>
      <Route path ="/" element= {<Home/>} />
      <Route path='/room/:roomId' element={<Room/>} />
      <Route path='/join' element={<JoinRoom/>} />
      <Route path='/join/:roomId' element={<JoinRoom/>} />
    </Routes>
    </BrowserRouter>
  )
}

export default App
