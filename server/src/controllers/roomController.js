import { createRoomService } from '../services/roomService.js';
import { joinRoomServices } from '../services/roomService.js';

export const createRoom = async (req, res) => {
  try {

    const roomDetails = await createRoomService();

    return res.status(201).json({
      success: true,
      ...roomDetails,
    });
  } catch (error) {
    console.error('Error in createRoom controller:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create room',
    });
  }
};

export const joinRoom = async (req,res) => {
  try {
    const {roomId, token } = req.body;

    if(!roomId || !token){
      return res.status(400).json({
        success : false,
        message : 'Both roomId and token are required',
      });
    }

    const result = await joinRoomServices(roomId , token);

    return res.status(200).json({
      success : true,
      data : result,
    })
  }catch (error){
    return res.status(error.status || 500).json({
      success : false,
      message : error.message || 'Server error while joining room'
    })
  }
}