import os
import sys
import gzip
import base64
import asyncio
import json
import time
import re
from collections import defaultdict
from functools import wraps
from flask import Flask, jsonify, request, Response, stream_with_context, redirect
from flask_cors import CORS

from notebooklm import NotebookLMClient

# Rate limiting configuration
RATE_LIMIT_REQUESTS = int(os.environ.get('RATE_LIMIT_REQUESTS', 30))  # requests per window
RATE_LIMIT_WINDOW = int(os.environ.get('RATE_LIMIT_WINDOW', 60))  # window in seconds
rate_limit_storage = defaultdict(list)  # {ip: [timestamp1, timestamp2, ...]}


def rate_limit(f):
    """Rate limit decorator for API endpoints."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        # Get client IP
        client_ip = request.headers.get('X-Forwarded-For', request.remote_addr)
        if client_ip and ',' in client_ip:
            client_ip = client_ip.split(',')[0].strip()
        
        current_time = time.time()
        window_start = current_time - RATE_LIMIT_WINDOW
        
        # Clean old requests outside the window
        rate_limit_storage[client_ip] = [
            ts for ts in rate_limit_storage[client_ip] 
            if ts > window_start
        ]
        
        # Check if limit exceeded
        if len(rate_limit_storage[client_ip]) >= RATE_LIMIT_REQUESTS:
            return jsonify({
                'success': False,
                'error': 'Rate limit exceeded. Please try again later.',
                'retry_after': int(RATE_LIMIT_WINDOW - (current_time - rate_limit_storage[client_ip][0]))
            }), 429
        
        # Record this request
        rate_limit_storage[client_ip].append(current_time)
        
        return f(*args, **kwargs)
    return decorated_function

# Patterns to filter out internal thinking/process text from Google
INTERNAL_THINKING_PATTERNS = [
    re.compile(r'\*\*Summarizing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Analyzing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Processing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Evaluating.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reviewing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Synthesizing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Examining.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Considering.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reflecting.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Planning.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Drafting.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Finalizing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Checking.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Verifying.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Researching.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Investigating.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Exploring.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Assessing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Comparing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Contrasting.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Identifying.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Outlining.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Structuring.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Organizing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Formulating.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Developing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Constructing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Building.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Creating.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Generating.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Producing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Composing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Writing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Editing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Revising.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Polishing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Refining.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Improving.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Enhancing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Optimizing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Perfecting.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Completing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Concluding.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Summarizing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Recapping.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Wrapping up.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Final thoughts.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Key takeaways.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Main points.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Important notes.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Critical insights.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Essential information.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Core concepts.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Fundamental principles.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Basic ideas.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Underlying themes.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Central arguments.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Key findings.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Major conclusions.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Significant results.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Notable observations.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Interesting patterns.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Emerging trends.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Developing themes.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Evolving perspectives.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Shifting viewpoints.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Changing dynamics.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Transforming landscapes.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Evolving contexts.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Adapting strategies.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Adjusting approaches.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Modifying tactics.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Refining methods.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Improving techniques.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Enhancing processes.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Optimizing workflows.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Streamlining operations.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Maximizing efficiency.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Minimizing waste.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reducing redundancy.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Eliminating duplication.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Consolidating efforts.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Integrating systems.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Unifying platforms.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Harmonizing components.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Synchronizing elements.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Aligning resources.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Coordinating activities.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Managing tasks.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Organizing work.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Scheduling operations.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Planning activities.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Preparing materials.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Gathering resources.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Collecting data.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Acquiring information.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Obtaining details.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Retrieving facts.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Accessing records.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Consulting sources.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reviewing literature.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Examining documents.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Studying materials.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Analyzing content.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Interpreting meaning.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Understanding context.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Grasping significance.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Comprehending implications.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Appreciating nuances.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Recognizing subtleties.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Perceiving distinctions.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Discerning differences.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Differentiating factors.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Distinguishing features.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Characterizing elements.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Describing attributes.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Detailing properties.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Specifying qualities.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Defining characteristics.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Explaining traits.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Clarifying aspects.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Elucidating facets.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Illuminating dimensions.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Highlighting features.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Emphasizing points.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Stressing elements.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Underscoring aspects.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Accentuating factors.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Prioritizing considerations.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Ranking criteria.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Ordering priorities.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Sequencing steps.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Arranging components.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Configuring settings.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Establishing parameters.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Setting conditions.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Defining constraints.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Specifying requirements.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Stipulating terms.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Prescribing guidelines.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Mandating standards.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Requiring compliance.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Enforcing rules.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Implementing policies.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Executing procedures.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Performing operations.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Conducting activities.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Carrying out tasks.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Fulfilling functions.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Serving purposes.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Meeting objectives.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Achieving goals.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Accomplishing aims.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Realizing targets.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Attaining outcomes.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Delivering results.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Producing outputs.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Generating products.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Creating deliverables.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Forming conclusions.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Drawing inferences.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Making deductions.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reaching decisions.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Arriving at judgments.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Forming opinions.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Developing perspectives.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Shaping viewpoints.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Influencing attitudes.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Affecting beliefs.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Impacting perceptions.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Shifting understandings.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Changing minds.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Transforming thinking.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Evolving ideas.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Progressing thoughts.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Advancing concepts.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Moving forward.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Proceeding ahead.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Continuing onward.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Progressing further.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Advancing beyond.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Moving past.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Going forward.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Looking ahead.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Planning next.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Preparing upcoming.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Ready for.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Set to.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*About to.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Getting ready.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Warming up.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Starting up.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Booting up.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Initializing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Loading.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Activating.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Engaging.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Commencing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Initiating.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Launching.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Beginning.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Starting.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Opening.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Kicking off.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Getting started.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Diving in.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Jumping in.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Taking off.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Lifting off.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Blasting off.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Rocketing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Soaring.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Flying.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Cruising.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Sailing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Gliding.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Coasting.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Drifting.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Floating.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Hovering.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Hanging.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Pausing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Stopping.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Halting.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Ceasing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Ending.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Finishing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Closing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Shutting down.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Powering off.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Turning off.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Switching off.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Cutting off.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Breaking off.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Tearing off.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Ripping off.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Pulling off.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Taking off.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Stripping off.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Peeling off.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Slipping off.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Falling off.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Dropping off.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Rolling off.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Sliding off.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Gliding off.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Slipping away.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Fading away.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Disappearing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Vanishing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Dissolving.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Evaporating.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Melting away.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Fading out.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Dying out.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Burning out.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Fizzling out.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Petering out.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Tapering off.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Winding down.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Cooling down.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Settling down.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Calming down.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Quietening down.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Dying down.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Slowing down.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Easing off.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Letting up.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Backing off.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Stepping back.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Pulling back.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Drawing back.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Retreating.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Withdrawing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Receding.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Falling back.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Moving back.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Going back.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Coming back.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Returning.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reverting.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Regressing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Retrogressing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Backtracking.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Retracing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Revisiting.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reviewing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reconsidering.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Rethinking.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reevaluating.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reassessing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reappraising.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reexamining.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reinspecting.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Rechecking.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reverifying.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reconfirming.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Revalidating.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reauthenticating.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Recertifying.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reaccrediting.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reendorsing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reapproving.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reauthorizing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Recommissioning.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reinstating.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reestablishing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reinstituting.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reintroducing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Relaunching.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reinitiating.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Restarting.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Rebooting.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Resetting.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Refreshing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Renewing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Restoring.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Recovering.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Retrieving.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reclaiming.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Recapturing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Recouping.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Regaining.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reacquiring.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reobtaining.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reprocuring.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Resecuring.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reaccomplishing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reachieving.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reattaining.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Refulfilling.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Resatisfying.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Remeeting.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Resatisfying.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Recompleting.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reexecuting.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reperforming.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Redelivering.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Reproducing.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Regenerating.*?\*\*', re.IGNORECASE),
    re.compile(r'\*\*Replicating.*?\*\*', re.IGNORECASE),
]


def is_internal_thinking(text: str) -> bool:
    """Check if text is internal thinking/process text from Google."""
    if not text or not text.strip():
        return True
    
    # Check against all patterns
    for pattern in INTERNAL_THINKING_PATTERNS:
        if pattern.search(text):
            return True
    
    # Check if text is just whitespace or newlines
    if not text.strip():
        return True
    
    return False


from notebooklm import NotebookLMClient

COMPRESSED_AUTH = os.environ.get('NOTEBOOKLM_AUTH_COMPRESSED', '')

if COMPRESSED_AUTH:
    auth_json = gzip.decompress(base64.b64decode(COMPRESSED_AUTH)).decode()
    os.environ['NOTEBOOKLM_AUTH_JSON'] = auth_json

app = Flask(__name__, static_folder='../frontend/dist', static_url_path='/static')
CORS(app)

IS_SERVERLESS = bool(os.environ.get('SERVERLESS'))

# Register admin blueprint
try:
    from admin import admin_bp
    app.register_blueprint(admin_bp)
except ImportError as e:
    try:
        from scf.admin import admin_bp
        app.register_blueprint(admin_bp)
    except ImportError as e2:
        print(f"Warning: Could not import admin blueprint: {e} / {e2}")

# Register person blueprint
try:
    from person_api import person_bp
    app.register_blueprint(person_bp)
except ImportError as e:
    try:
        from scf.person_api import person_bp
        app.register_blueprint(person_bp)
    except ImportError as e2:
        print(f"Warning: Could not import person blueprint: {e} / {e2}")

# Register notebook/source catalog blueprint
try:
    from catalog_api import catalog_bp
    app.register_blueprint(catalog_bp)
except ImportError as e:
    try:
        from scf.catalog_api import catalog_bp
        app.register_blueprint(catalog_bp)
    except ImportError as e2:
        print(f"Warning: Could not import catalog blueprint: {e} / {e2}")

# Register section analyzer blueprint
try:
    from section_analyzer import section_bp
    app.register_blueprint(section_bp)
except ImportError as e:
    try:
        from scf.section_analyzer import section_bp
        app.register_blueprint(section_bp)
    except ImportError as e2:
        print(f"Warning: Could not import section blueprint: {e} / {e2}")

def run_async(coro):
    """Run async coroutine in a thread pool to avoid gevent conflicts."""
    import concurrent.futures
    
    def run_in_new_loop():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            return loop.run_until_complete(coro)
        finally:
            loop.close()
    
    with concurrent.futures.ThreadPoolExecutor() as executor:
        future = executor.submit(run_in_new_loop)
        return future.result()

@app.route('/')
def hello_world():
    return 'NotebookLM API is running'

@app.route('/health')
def health():
    return jsonify(status="ok")

@app.route('/api/notebooks', methods=['GET'])
def list_notebooks():
    """List published notebook-backed libraries."""
    try:
        try:
            from notebook_service import list_catalog_notebooks
        except ImportError:
            from scf.notebook_service import list_catalog_notebooks

        notebooks = list_catalog_notebooks(include_unpublished=False)
        notebooks = [{
            'id': item['id'],
            'title': item['title'],
            'description': item.get('description', ''),
            'cover_url': item.get('cover_url', ''),
            'accountName': item.get('account_name'),
            'source_count': item.get('source_count', 0),
        } for item in notebooks]
        return jsonify(success=True, data=notebooks)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify(success=False, error=str(e)), 500


async def get_client_for_notebook(notebook_id):
    """Dynamically instantiate a NotebookLMClient authenticated for the owning account."""
    try:
        from notebook_service import get_client_for_notebook_async
    except ImportError:
        from scf.notebook_service import get_client_for_notebook_async
    return await get_client_for_notebook_async(notebook_id)

@app.route('/api/notebooks/<notebook_id>/sources', methods=['GET'])
def list_sources(notebook_id):
    try:
        try:
            from notebook_service import sync_notebook_sources
        except ImportError:
            from scf.notebook_service import sync_notebook_sources
        result = sync_notebook_sources(notebook_id, include_unpublished=False)
        return jsonify(success=True, data=result)
    except Exception as e:
        return jsonify(success=False, error=str(e)), 500

@app.route('/api/notebooks/<notebook_id>/sources/<source_id>', methods=['GET'])
def get_source(notebook_id, source_id):
    try:
        try:
            from notebook_service import get_source_record
        except ImportError:
            from scf.notebook_service import get_source_record
        result = get_source_record(notebook_id, source_id, include_unpublished=False)
        if not result:
            return jsonify(success=False, error='Source not found'), 404
        return jsonify(success=True, data=result)
    except Exception as e:
        return jsonify(success=False, error=str(e)), 500

@app.route('/api/notebooks/<notebook_id>/sources/<source_id>/fulltext', methods=['GET'])
def get_source_fulltext(notebook_id, source_id):
    try:
        try:
            from notebook_service import get_source_document_text
        except ImportError:
            from scf.notebook_service import get_source_document_text
        result = get_source_document_text(notebook_id, source_id)
        return jsonify(success=True, data=result)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify(success=False, error=str(e)), 500

@app.route('/api/chat', methods=['POST'])
@rate_limit
def chat():
    import time
    start_time = time.time()
    try:
        data = request.get_json()
        if not data:
            return jsonify(success=False, error="Request body required"), 400
        
        notebook_id = data.get('notebook_id')
        question = data.get('question')
        conversation_id = data.get('conversation_id')
        source_ids = data.get('source_ids')
        stream = data.get('stream', False)
        
        if not notebook_id:
            return jsonify(success=False, error="notebook_id required"), 400
        if not question:
            return jsonify(success=False, error="question required"), 400
        
        print(f"[CHAT] 开始处理问题: {question[:50]}...")
        chat_start = time.time()
        
        async def fetch():
            async with await get_client_for_notebook(notebook_id) as client:
                result = await client.chat.ask(
                    notebook_id, 
                    question, 
                    conversation_id=conversation_id,
                    source_ids=source_ids
                )
                print(f"[CHAT] 去重前引用数量: {len(result.references) if result.references else 0}")
                if result.references:
                    unique_keys = set()
                    for ref in result.references:
                        key = (ref.source_id, ref.start_char, ref.end_char)
                        unique_keys.add(key)
                    print(f"[CHAT] 唯一引用数量: {len(unique_keys)}")
                return {
                    "answer": result.answer,
                    "conversation_id": result.conversation_id,
                    "turn_number": result.turn_number,
                    "is_follow_up": result.is_follow_up,
                    "references": [{
                        "source_id": ref.source_id,
                        "citation_number": ref.citation_number,
                        "cited_text": ref.cited_text,
                        "start_char": ref.start_char,
                        "end_char": ref.end_char,
                    } for ref in result.references] if result.references else []
                }
        
        result = run_async(fetch())
        print(f"[CHAT] NotebookLM API 耗时: {time.time() - chat_start:.2f}s")
        print(f"[CHAT] 引用数量: {len(result.get('references', []))}")
        if result.get('references'):
            for i, ref in enumerate(result['references'][:5]):
                print(f"  [{ref['citation_number']}] source_id: {ref['source_id'][:8]}..., start: {ref['start_char']}, end: {ref['end_char']}")
        
        print(f"[CHAT] 总耗时: {time.time() - start_time:.2f}s")
        
        return jsonify(success=True, data=result)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify(success=False, error=str(e)), 500


@app.route('/api/chat/stream', methods=['POST'])
@rate_limit
def chat_stream():
    """Stream chat response using Server-Sent Events (SSE).
    
    This endpoint provides a streaming interface using NotebookLM's ask_stream
    for true streaming from the source.
    """
    try:
        # Ensure we read the request data as UTF-8
        request_data = request.get_data(as_text=True)
        data = json.loads(request_data) if request_data else None
        
        if not data:
            return jsonify(success=False, error="Request body required"), 400
        
        notebook_id = data.get('notebook_id')
        question = data.get('question')
        conversation_id = data.get('conversation_id')
        source_ids = data.get('source_ids')
        
        if not notebook_id:
            return jsonify(success=False, error="notebook_id required"), 400
        if not question:
            return jsonify(success=False, error="question required"), 400
        
        import datetime
        start_time = datetime.datetime.now()
        print(f"[{start_time.strftime('%H:%M:%S.%f')[:-3]}] [CHAT STREAM] 开始处理问题: {question[:50]}...")
        
        # Pre-fetch source_ids to avoid extra RPC call in ask_stream
        async def get_source_ids(client, nb_id):
            try:
                source_ids = await client._core.get_source_ids(nb_id)
                print(f"[{datetime.datetime.now().strftime('%H:%M:%S.%f')[:-3]}] [CHAT STREAM] 获取到 {len(source_ids)} 个source_ids")
                return source_ids
            except Exception as e:
                print(f"[{datetime.datetime.now().strftime('%H:%M:%S.%f')[:-3]}] [CHAT STREAM] 获取source_ids失败: {e}")
                return []
        
        async def stream_response():
            """Stream response from NotebookLM using ask_stream."""
            async with await get_client_for_notebook(notebook_id) as client:
                effective_source_ids = source_ids
                if effective_source_ids is None:
                    effective_source_ids = await get_source_ids(client, notebook_id)
                
                stream_start = datetime.datetime.now()
                print(f"[{stream_start.strftime('%H:%M:%S.%f')[:-3]}] [CHAT STREAM] 开始调用ask_stream...")
                
                async for chunk in client.chat.ask_stream(
                    notebook_id, 
                    question, 
                    conversation_id=conversation_id,
                    source_ids=effective_source_ids
                ):
                    yield chunk
        
        def generate():
            """Generate SSE events from streaming response."""
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            
            first_chunk_time = None
            chunk_count = 0
            final_conversation_id = None
            final_references = []
            
            try:
                async_gen = stream_response()
                
                while True:
                    try:
                        chunk = loop.run_until_complete(async_gen.__anext__())
                        chunk_count += 1
                        
                        if chunk_count == 1:
                            first_chunk_time = datetime.datetime.now()
                            first_chunk_delay = (first_chunk_time - start_time).total_seconds()
                            print(f"[{first_chunk_time.strftime('%H:%M:%S.%f')[:-3]}] [CHAT STREAM] 收到第1个chunk，延迟 {first_chunk_delay:.3f}s")
                        
                        if chunk.is_final:
                            # Final chunk with metadata
                            final_conversation_id = chunk.conversation_id
                            final_references = [{
                                "source_id": ref.source_id,
                                "citation_number": ref.citation_number,
                                "cited_text": ref.cited_text,
                                "start_char": ref.start_char,
                                "end_char": ref.end_char,
                            } for ref in chunk.references] if chunk.references else []
                            
                            final_data = f"data: {json.dumps({'done': True, 'conversation_id': final_conversation_id, 'references': final_references}, ensure_ascii=False)}\n\n"
                            yield final_data.encode('utf-8')
                            
                            done_time = datetime.datetime.now()
                            total_time = (done_time - start_time).total_seconds()
                            print(f"[{done_time.strftime('%H:%M:%S.%f')[:-3]}] [CHAT STREAM] 流式输出完成，共 {chunk_count} 个chunk，总耗时 {total_time:.2f}s")
                            break
                        else:
                            # Regular text chunk
                            if chunk.text:
                                # Filter out internal thinking text from Google
                                if is_internal_thinking(chunk.text):
                                    print(f"[{datetime.datetime.now().strftime('%H:%M:%S.%f')[:-3]}] [CHAT STREAM] 过滤内部思考文本: {chunk.text[:50]}...")
                                    continue
                                
                                # Build response with text and optional references
                                response_data: dict[str, Any] = {'chunk': chunk.text}
                                
                                # Include references if present in this chunk
                                if chunk.references:
                                    response_data['references'] = [{
                                        "source_id": ref.source_id,
                                        "citation_number": ref.citation_number,
                                        "cited_text": ref.cited_text,
                                        "start_char": ref.start_char,
                                        "end_char": ref.end_char,
                                    } for ref in chunk.references]
                                
                                data_line = f"data: {json.dumps(response_data, ensure_ascii=False)}\n\n"
                                yield data_line.encode('utf-8')
                            
                    except StopAsyncIteration:
                        break
                    except UnicodeDecodeError as e:
                        print(f"[CHAT STREAM] 编码错误，跳过: {e}")
                        continue
                    except Exception as e:
                        print(f"[CHAT STREAM] 处理chunk时出错: {e}")
                        continue
            finally:
                loop.close()
        
        return Response(
            generate(),
            mimetype='text/event-stream',
            headers={
                'Cache-Control': 'no-cache',
                'X-Accel-Buffering': 'no',
                'Content-Type': 'text/event-stream; charset=utf-8',
            }
        )
    except Exception as e:
        import traceback
        traceback.print_exc()
        
        def error_generate():
            yield f"data: {json.dumps({'error': str(e)}, ensure_ascii=False)}\n\n".encode('utf-8')
        
        return Response(
            error_generate(),
            mimetype='text/event-stream',
            status=200
        )

@app.route('/api/notebooks/<notebook_id>/conversations/<conversation_id>/history', methods=['GET'])
def get_conversation_history(notebook_id, conversation_id):
    try:
        async def fetch():
            async with await get_client_for_notebook(notebook_id) as client:
                history = await client.conversations.get_history(conversation_id)
                return {
                    "messages": [
                        {
                            "id": msg.id,
                            "role": msg.role,
                            "content": msg.content,
                            "timestamp": msg.timestamp.isoformat() if msg.timestamp else None,
                            "references": [
                                {
                                    "citation_number": ref.citation_number,
                                    "source_id": ref.source_id,
                                    "start_char": ref.start_char,
                                    "end_char": ref.end_char,
                                    "cited_text": ref.cited_text
                                }
                                for ref in (msg.references or [])
                            ] if msg.references else None
                        }
                        for msg in history.messages
                    ]
                }
        
        result = run_async(fetch())
        return jsonify(success=True, data=result)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify(success=False, error=str(e)), 500


@app.route('/api/notebooks/<notebook_id>/generate-timeline', methods=['POST'])
@rate_limit
def generate_timeline(notebook_id):
    """Generate a timeline from notebook sources.
    
    Request body:
        - query: Optional query to focus on specific events
        
    Returns:
        - timeline: List of timeline events with date, title, description, and source references
    """
    try:
        data = request.get_json() or {}
        query = data.get('query', '请分析这些文献中的历史事件，生成一个详细的时间线，包含日期、事件标题、事件描述和相关的引用来源。')
        
        async def fetch():
            async with await get_client_for_notebook(notebook_id) as client:
                # Ask the notebook to generate a timeline
                timeline_prompt = f"""{query}

请按以下 JSON 格式返回时间线数据：
{{
  "timeline": [
    {{
      "date": "YYYY-MM-DD 或 YYYY-MM 或 YYYY",
      "title": "事件标题",
      "description": "事件详细描述",
      "sources": ["引用来源1", "引用来源2"]
    }}
  ]
}}

注意：
1. 日期格式可以是具体的日、月或年份
2. 按时间顺序排列
3. 每个事件都要有可靠的文献来源支持
4. 描述要简洁但信息完整"""

                response = await client.chat.ask(
                    notebook_id=notebook_id,
                    question=timeline_prompt
                )
                
                # Try to parse the JSON from the response
                content = response.answer
                
                # Extract JSON from markdown code blocks if present
                import json
                import re
                
                # Look for JSON in code blocks
                json_match = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', content, re.DOTALL)
                if json_match:
                    content = json_match.group(1)
                
                # Try to find JSON object directly
                json_match = re.search(r'(\{[\s\S]*"timeline"[\s\S]*\})', content)
                if json_match:
                    content = json_match.group(1)
                
                try:
                    timeline_data = json.loads(content)
                    return timeline_data
                except json.JSONDecodeError:
                    # If JSON parsing fails, return the raw content
                    return {
                        "timeline": [],
                        "raw_content": content,
                        "error": "Failed to parse timeline data"
                    }
        
        result = run_async(fetch())
        return jsonify(success=True, data=result)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify(success=False, error=str(e)), 500


@app.route('/api/notebooks/<notebook_id>/generate-relations', methods=['POST'])
@rate_limit
def generate_relations(notebook_id):
    """Generate person relationship graph from notebook sources.
    
    Request body:
        - query: Optional query to focus on specific person or topic
        
    Returns:
        - nodes: List of persons with attributes
        - links: List of relationships between persons
    """
    try:
        data = request.get_json() or {}
        query = data.get('query', '请分析这些文献中的人物关系，提取所有重要人物及其之间的关系，包括亲属关系、同事关系、政治关系等。')
        
        async def fetch():
            async with await get_client_for_notebook(notebook_id) as client:
                relations_prompt = f"""{query}

请按以下 JSON 格式返回人物关系数据：
{{
  "nodes": [
    {{
      "id": "人物唯一标识（如：maozedong）",
      "name": "人物姓名",
      "role": "角色/职位",
      "group": "所属群体（如：共产党、国民党、知识分子等）",
      "importance": 10
    }}
  ],
  "links": [
    {{
      "source": "源人物id",
      "target": "目标人物id",
      "relation": "关系类型（如：同事、上下级、亲属、朋友、敌对）",
      "strength": 5
    }}
  ]
}}

注意：
1. importance 范围 1-10，表示人物重要性
2. strength 范围 1-10，表示关系强度
3. 只包含文献中明确提到的人物和关系
4. group 用于分类着色"""

                response = await client.chat.ask(
                    notebook_id=notebook_id,
                    question=relations_prompt
                )
                
                content = response.answer
                
                import json
                import re
                
                json_match = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', content, re.DOTALL)
                if json_match:
                    content = json_match.group(1)
                
                json_match = re.search(r'(\{[\s\S]*"nodes"[\s\S]*"links"[\s\S]*\})', content)
                if json_match:
                    content = json_match.group(1)
                
                try:
                    relations_data = json.loads(content)
                    return relations_data
                except json.JSONDecodeError:
                    return {
                        "nodes": [],
                        "links": [],
                        "raw_content": content,
                        "error": "Failed to parse relations data"
                    }
        
        result = run_async(fetch())
        return jsonify(success=True, data=result)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify(success=False, error=str(e)), 500


def generate_user_id(device_id):
    """Generate a unique user ID from device_id."""
    import hashlib
    hash_obj = hashlib.md5(device_id.encode())
    return hash_obj.hexdigest()[:16]

@app.route('/api/user/nickname', methods=['GET'])
def get_user_nickname():
    """Get or generate a nickname for the user."""
    device_id = request.headers.get('X-Device-ID')
    if not device_id:
        return jsonify(success=False, error='Device ID required'), 400
    
    # Generate user_id
    user_id = generate_user_id(device_id)
    
    # Get or assign species name from database
    nickname = SpeciesNameManager.get_or_assign_name(device_id)
    if not nickname:
        return jsonify(success=False, error='Failed to generate nickname'), 500
    
    return jsonify(success=True, data={
        'nickname': nickname,
        'user_id': user_id,
        'device_id': device_id,
        'is_anonymous': True
    })

@app.route('/api/user/nickname', methods=['POST'])
def set_user_nickname():
    """Allow user to set their own nickname."""
    device_id = request.headers.get('X-Device-ID')
    if not device_id:
        return jsonify(success=False, error='Device ID required'), 400
    
    # Generate user_id
    user_id = generate_user_id(device_id)
    
    data = request.get_json()
    nickname = data.get('nickname', '').strip()
    
    if not nickname:
        return jsonify(success=False, error='Nickname required'), 400
    
    if len(nickname) > 20:
        return jsonify(success=False, error='Nickname too long (max 20 chars)'), 400
    
    # Mark the species name as used if it's from our list
    SpeciesNameManager.mark_name_used(nickname, device_id)
    
    return jsonify(success=True, data={
        'nickname': nickname,
        'user_id': user_id,
        'device_id': device_id,
        'is_anonymous': True
    })

@app.route('/api/user/nickname/stats', methods=['GET'])
def get_nickname_stats():
    """Get species name usage statistics."""
    stats = SpeciesNameManager.get_stats()
    return jsonify(success=True, data=stats)


# Import database module
from database import (
    ReadingProgressManager, ReadingHistoryManager, BookmarkManager,
    SpeciesNameManager
)

# Reading Progress APIs
@app.route('/api/user/progress/<book_id>', methods=['GET'])
def get_reading_progress(book_id):
    """Get reading progress for a book."""
    device_id = request.headers.get('X-Device-ID')
    if not device_id:
        return jsonify(success=False, error='Device ID required'), 400
    
    # Generate user_id from device_id
    import hashlib
    user_id = hashlib.md5(device_id.encode()).hexdigest()[:16]
    
    progress = ReadingProgressManager.get_progress(user_id, book_id)
    if progress:
        return jsonify(success=True, data=progress)
    return jsonify(success=True, data=None)

@app.route('/api/user/progress', methods=['POST'])
def save_reading_progress():
    """Save reading progress for a book."""
    device_id = request.headers.get('X-Device-ID')
    if not device_id:
        return jsonify(success=False, error='Device ID required'), 400
    
    data = request.get_json()
    book_id = data.get('book_id')
    scroll_position = data.get('scroll_position', 0)
    chapter_id = data.get('chapter_id')
    book_title = data.get('book_title')
    library_id = data.get('library_id')
    library_name = data.get('library_name')
    
    if not book_id:
        return jsonify(success=False, error='Book ID required'), 400
    
    # Generate user_id from device_id
    import hashlib
    user_id = hashlib.md5(device_id.encode()).hexdigest()[:16]
    
    # Save progress
    success = ReadingProgressManager.save_progress(
        user_id, book_id, scroll_position, chapter_id
    )
    
    # Also update reading history
    if success:
        ReadingHistoryManager.add_history(
            user_id, book_id, book_title, library_id, library_name
        )
    
    return jsonify(success=success)

@app.route('/api/user/progress', methods=['GET'])
def get_all_progress():
    """Get all reading progress for a user."""
    device_id = request.headers.get('X-Device-ID')
    if not device_id:
        return jsonify(success=False, error='Device ID required'), 400
    
    import hashlib
    user_id = hashlib.md5(device_id.encode()).hexdigest()[:16]
    
    progress = ReadingProgressManager.get_all_progress(user_id)
    return jsonify(success=True, data=progress)


# Reading History APIs
@app.route('/api/user/history', methods=['GET'])
def get_reading_history():
    """Get reading history for a user."""
    device_id = request.headers.get('X-Device-ID')
    if not device_id:
        return jsonify(success=False, error='Device ID required'), 400
    
    import hashlib
    user_id = hashlib.md5(device_id.encode()).hexdigest()[:16]
    
    limit = request.args.get('limit', 50, type=int)
    history = ReadingHistoryManager.get_history(user_id, limit)
    return jsonify(success=True, data=history)


# Bookmark APIs
@app.route('/api/user/bookmarks/<book_id>', methods=['GET'])
def get_bookmarks(book_id):
    """Get bookmarks for a book."""
    device_id = request.headers.get('X-Device-ID')
    if not device_id:
        return jsonify(success=False, error='Device ID required'), 400
    
    import hashlib
    user_id = hashlib.md5(device_id.encode()).hexdigest()[:16]
    
    bookmarks = BookmarkManager.get_bookmarks(user_id, book_id)
    return jsonify(success=True, data=bookmarks)

@app.route('/api/user/bookmarks', methods=['POST'])
def add_bookmark():
    """Add a bookmark."""
    device_id = request.headers.get('X-Device-ID')
    if not device_id:
        return jsonify(success=False, error='Device ID required'), 400
    
    data = request.get_json()
    book_id = data.get('book_id')
    position = data.get('position')
    note = data.get('note')
    
    if not book_id or position is None:
        return jsonify(success=False, error='Book ID and position required'), 400
    
    import hashlib
    user_id = hashlib.md5(device_id.encode()).hexdigest()[:16]
    
    success = BookmarkManager.add_bookmark(user_id, book_id, position, note)
    return jsonify(success=success)

@app.route('/api/user/bookmarks/<int:bookmark_id>', methods=['DELETE'])
def delete_bookmark(bookmark_id):
    """Delete a bookmark."""
    device_id = request.headers.get('X-Device-ID')
    if not device_id:
        return jsonify(success=False, error='Device ID required'), 400
    
    import hashlib
    user_id = hashlib.md5(device_id.encode()).hexdigest()[:16]
    
    success = BookmarkManager.delete_bookmark(user_id, bookmark_id)
    return jsonify(success=success)


if __name__ == '__main__':
   app.run(host='0.0.0.0', port=9002)
