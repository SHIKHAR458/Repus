import express from "express";
import cors from 'cors';
import roomRoutes from './src/routes/roomRoutes.js'

const app = express();

app.use(cors({
  origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
}));
app.use(express.json());

app.use('/api/rooms', roomRoutes);

app.get('/' , (req,res) => {
    res.send("server is running")
})

export default app;
