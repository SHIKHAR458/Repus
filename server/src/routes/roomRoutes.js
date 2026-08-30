import express from 'express';
import { createRoom } from '../controllers/roomController.js';
import { joinRoom } from '../controllers/roomController.js';

const router = express.Router();

router.post('/create', createRoom);
router.post('/join' , joinRoom);

export default router;
