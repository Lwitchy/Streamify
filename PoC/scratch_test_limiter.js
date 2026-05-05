const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 2,
    handler: (req, res) => res.status(429).send('Done')
});

async function test() {
    const key = '127.0.0.1';
    
    console.log('Before hits:', await limiter.getKey(key));
    
    // Simulate a request
    const mockReq = { ip: key };
    const mockRes = { 
        set: () => {},
        getHeader: () => {},
        status: () => ({ send: () => {} }),
        on: () => {}
    };
    const mockNext = () => {};
    
    await limiter(mockReq, mockRes, mockNext);
    
    const status = await limiter.getKey(key);
    console.log('After 1 hit:', status);
}

test();
